// Background Agent spawn: start a detached agent, join it to a notification
// batch, and hand its ID back immediately.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { CompletionNotifier } from "../manager/completion-notifier.js";
import { streamToOutputFile } from "../platform/output-file.js";
import type { AgentRecord } from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import { resolveJoinMode } from "./invocation-config.js";
import { textResult } from "./tool-result.js";

export interface BackgroundAgentDeps {
  pi: ExtensionAPI;
  manager: Pick<AgentManager, "getRecord" | "getMaxConcurrent" | "spawn" | "awaitStartup">;
  widget: Pick<AgentWidget, "ensureTimer" | "update">;
  fleet: Pick<FleetList, "ensureTimer" | "update">;
  notifier: Pick<CompletionNotifier, "addToBatch">;
  settings: Readonly<Pick<RuntimeSettings, "defaultJoinMode">>;
}

export interface BackgroundAgentInput {
  ctx: ExtensionContext;
  toolCallId: string;
  params: { prompt: string; description: string; name?: string };
  call: Extract<AgentCallResolution, { ok: true }>;
  /** Opens the call's .output transcript on the record, when it is on. */
  attachTranscript: (rec: AgentRecord | undefined, agentId: string) => void;
}

/** Spawn one Agent call detached and return its tool result. Spawn errors throw. */
export async function startBackgroundAgent(deps: BackgroundAgentDeps, input: BackgroundAgentInput) {
  const { pi, manager, widget, fleet, notifier, settings } = deps;
  const { ctx, toolCallId, params, call, attachTranscript } = input;
  const {
    subagentType,
    fallbackNote,
    displayName,
    model,
    thinking,
    inheritContext,
    isolated,
    isolation,
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  } = call;

  const bgCallbacks = createActivityTracker();

  // Wrap onSessionCreated to wire output file streaming.
  // The callback lazily reads record.outputFile (set right after spawn)
  // rather than closing over a value that doesn't exist yet.
  let id: string;
  const origBgOnSession = bgCallbacks.onSessionCreated;
  bgCallbacks.onSessionCreated = (session: any) => {
    origBgOnSession(session);
    const rec = manager.getRecord(id);
    if (rec?.outputFile) {
      rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
    }
  };

  // A throw here means the agent never started. Let it out: pi marks a
  // tool call failed only when execute throws, and a returned message
  // reads to the model as a subagent that ran and reported this (#179).
  id = manager.spawn(pi, ctx, subagentType, params.prompt, {
    description: params.description,
    name: params.name,
    model,
    maxTurns: effectiveMaxTurns,
    isolated,
    inheritContext,
    thinkingLevel: thinking,
    isBackground: true,
    isolation,
    invocation: agentInvocation,
    rootSessionId: ctx.sessionManager.getSessionId(),
    ...bgCallbacks,
  });

  // Set output file + join mode synchronously after spawn, before the
  // event loop yields — onSessionCreated is async so this is safe.
  const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
  const record = manager.getRecord(id);
  if (record && joinMode) {
    record.joinMode = joinMode;
    record.toolCallId = toolCallId;
    attachTranscript(record, id);
  }

  // With isolation: "worktree" the agent isn't running yet — the repo
  // copy is an awaited git call. Wait for it here, after the synchronous
  // wiring above, so a strict-isolation failure still fails THIS tool
  // call instead of being reported as a subagent that ran (#179).
  await manager.awaitStartup(id);

  if (joinMode == null || joinMode === "async") {
    // Foreground/no join mode or explicit async — not part of any batch
  } else {
    // smart or group — add to current batch
    notifier.addToBatch(id, joinMode);
  }

  widget.ensureTimer();
  widget.update();
  fleet.ensureTimer();
  fleet.update();

  // Emit created event
  pi.events.emit("subagents:created", {
    id,
    type: subagentType,
    description: params.description,
    isBackground: true,
  });

  const isQueued = record?.status === "queued";
  return textResult(
    `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
    `Agent ID: ${id}\n` +
    `Type: ${displayName}\n` +
    `Description: ${params.description}\n` +
    (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
    (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
    `\nYou will be notified when this agent completes.\n` +
    `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
    `Do not duplicate this agent's work.`,
    { ...detailBaseFor(detailBase, record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
  );
}
