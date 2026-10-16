// The tools that act on an agent already started: `get_subagent_result`,
// `steer_subagent` and `stop_subagent`.

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import type { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager-rules.js";
import { steerAgent } from "./agent-runner.js";
import { type CompletionNotifier, QUEUE_WAIT_POLL_MS } from "./completion-notifier.js";
import { SUBAGENT_TOOL_NAMES } from "./extension-scope.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { getAgentConversation } from "./session-text.js";
import { getStatusNote, partialOutputSuffix } from "./status-note.js";
import { formatLifetimeTokens, textResult } from "./tool-result.js";
import type { AgentRecord } from "./types.js";
import { formatCost, formatDuration, getDisplayName } from "./ui/agent-format.js";
import { getLifetimeCost, getSessionContextPercent, type UsageReportingDeps, withUsageReporting } from "./usage.js";

export interface AgentControlToolsDeps {
  manager: Pick<AgentManager, "abort" | "getActivity">;
  notifier: Pick<CompletionNotifier, "cancelNudge">;
  settings: Readonly<Pick<RuntimeSettings, "showCost">>;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
  usageReporting: UsageReportingDeps;
}

export function registerAgentControlTools(pi: ExtensionAPI, deps: AgentControlToolsDeps): void {
  const { manager, notifier, settings, resolveAgentRef, usageReporting } = deps;

  function registerToolReportingUsage(tool: any): void {
    pi.registerTool(withUsageReporting(tool, usageReporting));
  }

  // ---- get_subagent_result tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (settings.showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status, record.stoppedBy)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        notifier.cancelNudge(record.id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (settings.showCost) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- stop_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STOP,
    label: "Stop Agent",
    description:
      "Stop a running or queued background agent. Fires its abort signal immediately; the tool result carries whatever " +
      "partial output the agent had streamed so far, and the full result still arrives via the usual completion notification.",
    promptSnippet: "Stop a running or queued background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to stop. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (record.status !== "running" && record.status !== "queued") {
        // Already terminal: the model's intent — that agent is not running —
        // is already satisfied. Success, not an error; the result is still there.
        return textResult(
          `Agent ${record.id} is not running (status: ${record.status}${getStatusNote(record.status, record.stoppedBy)}). ` +
          `Its result is still available — use get_subagent_result.`,
        );
      }

      const wasRunning = record.status === "running";
      const displayName = getDisplayName(record.type);
      // Before abort(): the forced-settle path (agent-manager.ts) reads this
      // off the record when it fires the completion notification, which for a
      // wedged agent may be the first time anything reads it.
      record.stoppedBy = "agent";
      manager.abort(record.id);

      if (!wasRunning) {
        return textResult(`Agent ${record.id} (${displayName}) stopped before it started running. No output was produced.`);
      }

      // The only partial output available synchronously — record.result isn't
      // written until the settle path runs, which for a wedged agent this tool
      // exists to interrupt hasn't happened yet.
      const partial = manager.getActivity(record.id)?.responseText?.trim();
      const preview = partial ? (partial.length > 500 ? `${partial.slice(0, 500)}…` : partial) : undefined;

      // Deliberately does NOT set resultConsumed or cancel the pending nudge:
      // record.result doesn't exist yet, so suppressing the notification here
      // would silently lose the full output for a model that doesn't think to
      // fetch it with get_subagent_result.
      return textResult(
        `Agent ${record.id} (${displayName}) stopped. Previous status: running.\n\n` +
        (preview
          ? `Partial output before the stop:\n${preview}`
          : "No partial output — the agent had not produced any assistant text yet.") +
        `\n\nThe full result will still arrive via the usual completion notification.`,
      );
    },
  }));
}
