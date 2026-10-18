// The `Agent` tool definition: parameter schema, rendering hooks, and the
// execute dispatch over schedule, resume, background and foreground spawns.

import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveAgentCall } from "./agent-call-resolution.js";
import type { AgentManager } from "./agent-manager.js";
import { startBackgroundAgent } from "./agent-tool-background.js";
import { buildAgentToolDescription } from "./agent-tool-description.js";
import { runForegroundAgent } from "./agent-tool-foreground.js";
import { renderAgentCall, renderAgentResult } from "./agent-tool-render.js";
import { resumeAgentCall } from "./agent-tool-resume.js";
import { scheduleAgentCall } from "./agent-tool-schedule.js";
import { getAvailableTypes } from "./agent-types.js";
import type { StartBackgroundResume } from "./background-resume.js";
import type { CompletionNotifier } from "./completion-notifier.js";
import { SUBAGENT_TOOL_NAMES } from "./extension-scope.js";
import { isolationParam } from "./invocation-config.js";
import { createOutputFilePath, writeInitialEntry } from "./output-file.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import type { SubagentScheduler } from "./schedule.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import { textResult } from "./tool-result.js";
import type { AgentRecord } from "./types.js";
import type { AgentWidget, UICtx } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

export interface AgentToolDeps {
  manager: Pick<
    AgentManager,
    "getRecord" | "getMaxConcurrent" | "resume" | "spawn" | "awaitStartup" | "getActivity" | "listAgents" | "spawnAndWait"
  >;
  scheduler: Pick<SubagentScheduler, "isActive" | "addJob" | "getNextRun">;
  widget: Pick<AgentWidget, "setUICtx" | "ensureTimer" | "update" | "markFinished">;
  fleet: Pick<FleetList, "ensureTimer" | "update" | "onAgentFinished">;
  notifier: Pick<CompletionNotifier, "addToBatch">;
  startBackgroundResume: StartBackgroundResume;
  reloadCustomAgents: () => void;
  settings: Readonly<Pick<
    RuntimeSettings,
    "schedulingEnabled" | "toolDescriptionMode" | "backgroundByDefault" | "defaultJoinMode" | "showCost"
  >>;
}

/**
 * Define the Agent tool. Returns the bare tool; the caller wraps it for usage
 * reporting and registers it. The description mode and the scheduling switch
 * are read once, here, so call this after persisted settings are applied.
 */
export function createAgentTool(pi: ExtensionAPI, deps: AgentToolDeps) {
  const { manager, scheduler, widget, fleet, notifier, startBackgroundResume, reloadCustomAgents, settings } = deps;

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    settings.schedulingEnabled ? scheduleParamShape : {};

  const agentToolDescription = buildAgentToolDescription({
    mode: settings.toolDescriptionMode,
    schedulingEnabled: settings.schedulingEnabled,
    worktreeEnabled: isWorktreeIsolationEnabled(),
  });

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise handle it yourself when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Only set this when the user named a model in their request; otherwise omit.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall: renderAgentCall,

    // Read at render time so toggling the cost setting applies to existing rows.
    renderResult: (result, options, theme, renderContext) =>
      renderAgentResult(result, options, theme, renderContext, settings.showCost),

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const call = resolveAgentCall(params, ctx, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: settings.backgroundByDefault,
      });
      if (!call.ok) return textResult(call.message);
      const { runInBackground, outputTranscript } = call;

      // `attachTranscript` is the SOLE gate for the .output transcript (whether
      // it is on comes from resolveAgentCall) — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      if (params.schedule) return scheduleAgentCall({ scheduler, settings }, { params, call });

      if (params.resume) {
        return resumeAgentCall(
          { manager, startBackgroundResume },
          { ctx, toolCallId, params: { prompt: params.prompt, resume: params.resume }, signal, call },
        );
      }

      if (runInBackground) {
        return startBackgroundAgent(
          { pi, manager, widget, fleet, notifier, settings },
          { ctx, toolCallId, params, call, attachTranscript },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      return runForegroundAgent(
        { pi, manager, widget, fleet, settings },
        { ctx, params, signal, onUpdate, call, attachTranscript },
      );
    },
  });

  return agentTool;
}
