import { normalizeMaxTurns } from "../config/runner-defaults.js";
import { isWorktreeRetained } from "../platform/worktree.js";
import { resumeAgent, type ToolActivity } from "../session/agent-runner.js";
import type { AgentActivity, AgentRecord, StopCause } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import type { Pool } from "./agent-manager-rules.js";
import { assertSignalCause, watchParentSignal } from "./parent-signal.js";
import { recordRunOutcome } from "./run-outcome.js";
import { enqueueRun, type QueuedRun } from "./run-queue.js";
import { cleanupWorktreeOutcome } from "./worktree-outcome.js";

export interface ResumeOptions {
  signal?: AbortSignal;
  isBackground?: boolean;
  signalCause?: StopCause;
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onStarted?: () => void;
  maxTurns?: number;
}

export interface ResumeDeps {
  agents: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity>;
  queue: QueuedRun[];
  poolFor: (record: AgentRecord) => Pool | undefined;
  poolHasRoom: (pool: Pool) => boolean;
  acquireSlot: (pool: Pool | undefined) => void;
  abort: (id: string, cause: StopCause) => boolean;
  settleRun: (record: AgentRecord) => void;
  reopenRun: (record: AgentRecord) => void;
  noteToolActivity: (id: string, activity: ToolActivity) => void;
  onStart?: (record: AgentRecord) => void;
  onCompact?: (record: AgentRecord, info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onUsage?: (record: AgentRecord, usage: LifetimeUsage) => void;
}

export async function resume(
  deps: ResumeDeps,
  id: string,
  prompt: string,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  const signal = options?.signal;
  assertSignalCause("resume", signal, options?.signalCause);
  const record = deps.agents.get(id);
  if (!record?.session) return undefined;
  if (record.status === "running" || record.status === "queued" || (!record.settled && record.promise !== undefined)) return undefined;
  if (record.worktree && (!record.worktreeResult || !isWorktreeRetained(record.worktree))) return undefined;

  const activity = deps.activities.get(id);
  if (activity) {
    activity.activeTools.clear();
    activity.responseText = "";
    activity.turnCount = 1;
    activity.session = record.session;
    if (options?.maxTurns !== undefined) activity.maxTurns = normalizeMaxTurns(options.maxTurns);
  }

  const isBackground = options?.isBackground === true;
  const controller = new AbortController();
  record.isBackground = isBackground;
  record.blocking = !isBackground;
  record.resultConsumed = false;
  record.result = undefined;
  record.worktreeResult = undefined;
  record.error = undefined;
  record.failureStage = undefined;
  record.stopCause = undefined;
  record.completedAt = undefined;
  deps.reopenRun(record);
  record.pool = undefined;
  record.promise = undefined;
  record.startGate = undefined;
  record.outputCleanup = undefined;
  record.abortController = controller;
  record.detachParentSignal = watchParentSignal(deps.abort, record, controller, signal, options?.signalCause);

  const begin = () => {
    try {
      startResume(deps, record, prompt, options);
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt ??= Date.now();
      deps.settleRun(record);
      throw err;
    }
  };

  const pool = deps.poolFor(record);
  if (pool !== undefined && !deps.poolHasRoom(pool)) {
    record.status = "queued";
    enqueueRun(deps.queue, record, pool, async () => {
      try { begin(); } catch { }
    });
  } else {
    begin();
  }

  if (isBackground) return record;
  const live: AgentRecord = record;
  if (live.status === "queued") await live.startGate;
  await live.promise;
  return record;
}

function startResume(
  deps: ResumeDeps,
  record: AgentRecord,
  prompt: string,
  options: ResumeOptions | undefined,
) {
  const controller = record.abortController;
  if (!record.session || !controller) return;
  const id = record.id;
  const parentSignal = options?.signal;
  const isCurrent = () => record.abortController === controller;

  const pool = deps.poolFor(record);
  record.status = "running";
  record.startedAt = Date.now();
  record.startGate = undefined;
  record.pool = pool;
  deps.acquireSlot(pool);
  deps.onStart?.(record);

  if (parentSignal?.aborted && options?.signalCause) deps.abort(id, options.signalCause);

  try { options?.onStarted?.(); } catch { }

  record.promise = resumeAgent(record.session, prompt, {
    onToolActivity: (activity) => {
      if (activity.type === "end") record.toolUses++;
      deps.noteToolActivity(id, activity);
      options?.onToolActivity?.(activity);
    },
    onAssistantUsage: (usage) => {
      addUsage(record.lifetimeUsage, usage);
      deps.onUsage?.(record, usage);
      options?.onAssistantUsage?.(usage);
    },
    onCompaction: (info) => {
      record.compactionCount++;
      deps.onCompact?.(record, info);
      options?.onCompaction?.(info);
    },
    signal: controller.signal,
  })
    .then(async ({ text, failure, failureStage }) => {
      if (isCurrent()) {
        recordRunOutcome(record, { text, failure, failureStage });
        await cleanupWorktreeOutcome(record, record.description);
        deps.settleRun(record);
      }
      return text;
    })
    .catch(async (err) => {
      if (isCurrent()) {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
        await cleanupWorktreeOutcome(record, record.description);
        deps.settleRun(record);
      }
      return "";
    });
}
