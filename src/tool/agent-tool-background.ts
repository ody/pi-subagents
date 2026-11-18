import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { filteredNote } from "../config/capability-policy.js";
import { modelReplacedNote } from "../config/model-scope.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { CompletionNotifier } from "../manager/completion-notifier.js";
import { streamToOutputFile } from "../platform/output-file.js";
import type { AgentRecord } from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import { resolveJoinMode } from "./invocation-config.js";
import { textResult } from "./tool-result.js";

export interface BackgroundAgentDeps {
  pi: ExtensionAPI;
  manager: Pick<AgentManager, "getRecord" | "getMaxConcurrent" | "spawn" | "awaitStartup">;
  widget: Pick<AgentWidget, "ensureTimer" | "update">;
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

export function backgroundRunFooter(record: AgentRecord | undefined, maxConcurrent: number): string {
  return (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
    (record?.status === "queued" ? `Position: queued (max ${maxConcurrent} concurrent)\n` : "") +
    `\nYou will be notified when this agent completes.\n` +
    `Use agent_get_result to retrieve full results, or agent_steer to send it messages.`;
}

export async function startBackgroundAgent(deps: BackgroundAgentDeps, input: BackgroundAgentInput) {
  const { pi, manager, widget, notifier, settings } = deps;
  const { ctx, toolCallId, params, call, attachTranscript } = input;
  const {
    subagentType,
    capability,
    agentConfig,
    ephemeral,
    displayName,
    model,
    modelReplaced,
    thinking,
    inheritContext,
    isolated,
    isolation,
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  } = call;

  const capabilityNote = (capability ? filteredNote(capability) : "") + modelReplacedNote(modelReplaced);
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

  pi.events.emit("agent:created", {
    id,
    type: subagentType,
    description: params.description,
    isBackground: true,
  });

  return textResult(
    `${capabilityNote}Agent ${record?.status === "queued" ? "queued" : "started"} in background.\n` +
    `Agent ID: ${id}\n` +
    `Type: ${displayName}\n` +
    `Description: ${params.description}\n` +
    `${backgroundRunFooter(record, manager.getMaxConcurrent())}\n` +
    `Do not duplicate this agent's work.`,
    { ...detailBaseFor(detailBase, record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
  );
}
