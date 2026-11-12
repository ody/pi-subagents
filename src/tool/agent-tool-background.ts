import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { filteredNote } from "../config/capability-policy.js";
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
  attachTranscript: (rec: AgentRecord | undefined, agentId: string) => void;
}

export async function startBackgroundAgent(deps: BackgroundAgentDeps, input: BackgroundAgentInput) {
  const { pi, manager, widget, fleet, notifier, settings } = deps;
  const { ctx, toolCallId, params, call, attachTranscript } = input;
  const {
    subagentType,
    capability,
    agentConfig,
    ephemeral,
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

  const capabilityNote = capability ? filteredNote(capability) : "";
  const bgCallbacks = createActivityTracker();

  let id: string;
  const origBgOnSession = bgCallbacks.onSessionCreated;
  bgCallbacks.onSessionCreated = (session: any) => {
    origBgOnSession(session);
    const rec = manager.getRecord(id);
    if (rec?.outputFile) {
      rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
    }
  };

  id = manager.spawn(pi, ctx, subagentType, params.prompt, {
    description: params.description,
    name: ephemeral ? undefined : params.name,
    agentConfig,
    ephemeral,
    capability,
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

  const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
  const record = manager.getRecord(id);
  if (record && joinMode) {
    record.joinMode = joinMode;
    record.toolCallId = toolCallId;
    attachTranscript(record, id);
  }

  await manager.awaitStartup(id);

  if (joinMode == null || joinMode === "async") {
  } else {
    notifier.addToBatch(id, joinMode);
  }

  widget.ensureTimer();
  widget.update();
  fleet.ensureTimer();
  fleet.update();

  pi.events.emit("subagents:created", {
    id,
    type: subagentType,
    description: params.description,
    isBackground: true,
  });

  const isQueued = record?.status === "queued";
  return textResult(
    `${capabilityNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
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
