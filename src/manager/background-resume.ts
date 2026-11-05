import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import { createOutputFilePath, ensureOutputFile, streamToOutputFile } from "../platform/output-file.js";
import { createActivityTracker } from "../tool/activity-tracker.js";
import { resolveJoinMode } from "../tool/invocation-config.js";
import type { AgentRecord } from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import type { AgentManager } from "./agent-manager.js";
import type { CompletionNotifier } from "./completion-notifier.js";

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

  return async (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: BackgroundResumeOpts,
  ): Promise<AgentRecord | undefined> => {
    const id = existing.id;
    const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const bgCallbacks = createActivityTracker();

    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      maxTurns: opts.maxTurns,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
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

    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  };
}
