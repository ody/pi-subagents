// Detached resume wiring: launch a background resume of an existing agent and
// wire the transcript, activity tracking, batching, UI refresh and events.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import type { AgentManager } from "./agent-manager.js";
import type { CompletionNotifier } from "./completion-notifier.js";
import { resolveJoinMode } from "./invocation-config.js";
import { createOutputFilePath, ensureOutputFile, streamToOutputFile } from "./output-file.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import type { AgentRecord } from "./types.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";

export interface BackgroundResumeOpts {
  outputTranscript: boolean;
  maxTurns?: number;
  toolCallId?: string;
}

export type StartBackgroundResume = (
  ctx: ExtensionContext,
  existing: AgentRecord,
  prompt: string,
  opts: BackgroundResumeOpts,
) => Promise<AgentRecord | undefined>;

export interface BackgroundResumeDeps {
  pi: Pick<ExtensionAPI, "events">;
  manager: Pick<AgentManager, "resume" | "getRecord">;
  notifier: Pick<CompletionNotifier, "addToBatch">;
  widget: Pick<AgentWidget, "markRunning" | "ensureTimer" | "update">;
  fleet: Pick<FleetList, "ensureTimer" | "update">;
  settings: Readonly<Pick<RuntimeSettings, "defaultJoinMode">>;
}

export function createBackgroundResume(deps: BackgroundResumeDeps): StartBackgroundResume {
  const { pi, manager, notifier, widget, fleet, settings } = deps;

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  return async (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: BackgroundResumeOpts,
  ): Promise<AgentRecord | undefined> => {
    const id = existing.id;
    const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const bgCallbacks = createActivityTracker();

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      maxTurns: opts.maxTurns,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (joinMode != null && joinMode !== 'async') {
      notifier.addToBatch(id, joinMode);
    }

    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  };
}
