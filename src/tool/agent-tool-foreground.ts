import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { filteredNote } from "../config/capability-policy.js";
import { modelReplacedNote } from "../config/model-scope.js";
import { normalizeMaxTurns } from "../config/runner-defaults.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import { streamToOutputFile } from "../platform/output-file.js";
import type { AgentActivity, AgentRecord } from "../types.js";
import { type AgentDetails, describeActivity, formatCost, formatMs, SPINNER } from "../ui/agent-format.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { getLifetimeCost } from "../usage.js";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "./status-note.js";
import { buildDetails, formatLifetimeTokens, textResult } from "./tool-result.js";

export interface ForegroundAgentDeps {
  pi: ExtensionAPI;
  manager: Pick<AgentManager, "getActivity" | "getRecord" | "listAgents" | "spawnAndWait">;
  widget: Pick<AgentWidget, "ensureTimer" | "markFinished">;
  fleet: Pick<FleetList, "ensureTimer" | "update" | "onAgentFinished">;
  settings: Readonly<Pick<RuntimeSettings, "showCost">>;
}

export interface ForegroundAgentInput {
  ctx: ExtensionContext;
  params: { prompt: string; description: string; name?: string };
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<any> | undefined;
  call: Extract<AgentCallResolution, { ok: true }>;
  attachTranscript: (rec: AgentRecord | undefined, agentId: string) => void;
}

export async function runForegroundAgent(deps: ForegroundAgentDeps, input: ForegroundAgentInput) {
  const { pi, manager, widget, fleet, settings } = deps;
  const { ctx, params, signal, onUpdate, call, attachTranscript } = input;
  const {
    subagentType,
    capability,
    agentConfig,
    ephemeral,
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
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;
  let queuedAhead: number | undefined;

  const emptyActivity: AgentActivity = {
    activeTools: new Map(), toolUses: 0, turnCount: 1, maxTurns: normalizeMaxTurns(effectiveMaxTurns), responseText: "",
  };
  const fgActivity = (): AgentActivity => (fgId ? manager.getActivity(fgId) : undefined) ?? emptyActivity;

  const streamUpdate = () => {
    const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
    const fgState = fgActivity();
    const details: AgentDetails = {
      ...detailBaseFor(detailBase, fgRecord),
      toolUses: fgState.toolUses,
      tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
      cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
      turnCount: fgState.turnCount,
      maxTurns: fgState.maxTurns,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: queuedAhead === undefined
        ? describeActivity(fgState.activeTools, fgState.responseText)
        : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
      details: details as any,
    });
  };

  const fgCallbacks = createActivityTracker(streamUpdate);

  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: any) => {
    origOnSession(session);
    if (queuedAhead !== undefined) {
      queuedAhead = undefined;
      streamUpdate();
    }
    for (const a of manager.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        widget.ensureTimer();
        fleet.ensureTimer();
        fleet.update();
        break;
      }
    }
    if (fgId) {
      const rec = manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  try {
    const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
      description: params.description,
      name: ephemeral ? undefined : (params.name as string | undefined),
      agentConfig,
      ephemeral,
      capability,
      model,
      maxTurns: effectiveMaxTurns,
      isolated,
      inheritContext,
      thinkingLevel: thinking,
      isolation,
      invocation: agentInvocation,
      signal,
      rootSessionId: ctx.sessionManager.getSessionId(),
      onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
      ...fgCallbacks,
    }, (fgAgentId) => {
      const fgRec = manager.getRecord(fgAgentId);
      attachTranscript(fgRec, fgAgentId);
    });
    record = fgResult.record;
  } finally {
    clearInterval(spinnerInterval);
    if (fgId) {
      widget.markFinished(fgId);
      fleet.onAgentFinished(fgId);
    }
  }

  const tokenText = formatLifetimeTokens(record);

  const details = buildDetails(detailBaseFor(detailBase, record), record, fgActivity(), { tokens: tokenText });

  if (record.status === "error") {
    return textResult(`${capabilityNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  if (settings.showCost) {
    const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
    if (costText) statsParts.push(costText);
  }
  return textResult(
    `${capabilityNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status, record.stoppedBy)}.\n\n` +
    (record.result?.trim() || "No output."),
    details,
  );
}
