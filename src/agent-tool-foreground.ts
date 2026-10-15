// Foreground Agent tool execution: spawn the agent, block until it finishes,
// and stream its progress to the tool row while it runs.

import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import type { AgentManager } from "./agent-manager.js";
import { streamToOutputFile } from "./output-file.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "./status-note.js";
import { buildDetails, formatLifetimeTokens, textResult } from "./tool-result.js";
import type { AgentActivity, AgentRecord } from "./types.js";
import { type AgentDetails, type AgentWidget, describeActivity, formatCost, formatMs, SPINNER } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";
import { getLifetimeCost } from "./usage.js";

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
  /** Opens the call's .output transcript on the record, when it is on. */
  attachTranscript: (rec: AgentRecord | undefined, agentId: string) => void;
}

/** Run one Agent call in the foreground and return its tool result. */
export async function runForegroundAgent(deps: ForegroundAgentDeps, input: ForegroundAgentInput) {
  const { pi, manager, widget, fleet, settings } = deps;
  const { ctx, params, signal, onUpdate, call, attachTranscript } = input;
  const {
    subagentType,
    fallbackNote,
    model,
    thinking,
    inheritContext,
    isolated,
    isolation,
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  } = call;

  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;
  // Set only while the spawn is parked on a foreground concurrency slot
  // (maxConcurrentForeground); undefined the rest of the time, including
  // always when the limit is unset.
  let queuedAhead: number | undefined;

  // Until `fgId` is known — the spawn may still be queued on a foreground
  // slot — there is no record to read activity off, so the display falls
  // back to an empty state carrying the turn ceiling this call asked for.
  const emptyActivity: AgentActivity = {
    activeTools: new Map(), toolUses: 0, turnCount: 1, maxTurns: effectiveMaxTurns, responseText: "",
  };
  const fgActivity = (): AgentActivity => (fgId ? manager.getActivity(fgId) : undefined) ?? emptyActivity;

  const streamUpdate = () => {
    // Spend from the record, everything else from the manager's live
    // activity. `fgId` is set in onSessionCreated below, which fires before
    // the first assistant message — so nothing is spent while this reads zero.
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
      // Deliberately still "running" while queued: the renderer routes any
      // status it doesn't know to raw text (see the catch-all below), which
      // would drop the spinner and read as hung. Only the activity line
      // changes — "thinking…" would be a lie for an agent that has not
      // started and may not for minutes.
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

  // Wire session creation: register in widget + stream to output file.
  // The output file path is set synchronously after spawn (below),
  // before onSessionCreated fires — same pattern as background agents.
  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: any) => {
    origOnSession(session);
    // It really started — stop reporting it as queued, and repaint now
    // rather than leaving the stale line up for the next spinner tick.
    // Guarded, so a spawn that never queued emits no extra update.
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
    // Stream conversation to output file (foreground agent logging)
    if (fgId) {
      const rec = manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  try {
    const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
      description: params.description,
      name: params.name as string | undefined,
      model,
      maxTurns: effectiveMaxTurns,
      isolated,
      inheritContext,
      thinkingLevel: thinking,
      isolation,
      invocation: agentInvocation,
      signal,
      rootSessionId: ctx.sessionManager.getSessionId(),
      // Deliberately does NOT set fgId: that drives agentActivity, the
      // widget and the `finally` cleanup below, none of which should see an
      // agent that has no session and may never get one.
      onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
      ...fgCallbacks,
    }, (fgAgentId) => {
      // onSpawned: called synchronously after spawn, before onSessionCreated fires.
      // Set up the output file so streamToOutputFile can pick it up.
      const fgRec = manager.getRecord(fgAgentId);
      attachTranscript(fgRec, fgAgentId);
    });
    record = fgResult.record;
  } finally {
    // Runs on both paths, so a startup throw — which now propagates, see
    // the background spawn above (#179) — no longer leaves the spinner
    // ticking or a finished agent on the widget.
    clearInterval(spinnerInterval);
    if (fgId) {
      widget.markFinished(fgId);
      fleet.onAgentFinished(fgId);
    }
  }

  // Get final token count — from the record, like the cost below it, so the
  // two describe the same work when the agent delegated to nested children.
  const tokenText = formatLifetimeTokens(record);

  const details = buildDetails(detailBaseFor(detailBase, record), record, fgActivity(), { tokens: tokenText });

  if (record.status === "error") {
    // Error headline + any partial output the run produced before failing.
    return textResult(`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  if (settings.showCost) {
    const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
    if (costText) statsParts.push(costText);
  }
  return textResult(
    `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status, record.stoppedBy)}.\n\n` +
    (record.result?.trim() || "No output."),
    details,
  );
}
