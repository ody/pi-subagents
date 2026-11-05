import { resumeAgent, type ToolActivity } from "../session/agent-runner.js";
import type { AgentActivity, AgentRecord } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import { occupiesPoolSlot, type Pool } from "./agent-manager-rules.js";

export interface ResumeOptions {
  isBackground?: boolean;
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onStarted?: () => void;
  maxTurns?: number;
}

interface ResumeQueueEntry {
  id: string;
  pool: Pool;
  start: () => Promise<void>;
  release: () => void;
}

export interface ResumeDeps {
  agents: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity>;
  queue: ResumeQueueEntry[];
  poolHasRoom: (pool: Pool) => boolean;
  acquireBackgroundSlot: () => void;
  releaseBackgroundSlot: () => void;
  abort: (id: string) => boolean;
  drainQueue: () => void;
  abortOwnedChildren: (parentId: string) => void;
  noteToolActivity: (id: string, activity: ToolActivity) => void;
  onStart?: (record: AgentRecord) => void;
  onComplete?: (record: AgentRecord) => void;
  onCompact?: (record: AgentRecord, info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onUsage?: (record: AgentRecord, usage: LifetimeUsage) => void;
}

export async function resume(
  deps: ResumeDeps,
  id: string,
  prompt: string,
  signal?: AbortSignal,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  const record = deps.agents.get(id);
  if (!record?.session) return undefined;

  const activity = deps.activities.get(id);
  if (activity) {
    activity.activeTools.clear();
    activity.responseText = "";
    activity.turnCount = 1;
    activity.session = record.session;
    if (options?.maxTurns !== undefined) activity.maxTurns = options.maxTurns;
  }

  if (options?.isBackground) {
    if (record.status === "running" || record.status === "queued") return undefined;

    record.isBackground = true;
    record.resultConsumed = false;
    record.result = undefined;
    record.error = undefined;
    record.completedAt = undefined;
    record.status = "queued";
    record.settled = false;

    const start = () => startResume(deps, id, record, prompt, signal, options);
    if (occupiesPoolSlot(record) && !deps.poolHasRoom("background")) {
      deps.queue.push({
        id,
        pool: "background",
        start: async () => {
          try {
            start();
          } catch (err) {
            record.status = "error";
            record.error = err instanceof Error ? err.message : String(err);
            record.completedAt = Date.now();
            deps.onComplete?.(record);
          }
        },
        release: () => {},
      });
    } else {
      start();
    }
    return record;
  }

  record.status = "running";
  record.startedAt = Date.now();
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;
  record.settled = false;

  try {
    const { text, failure } = await resumeAgent(record.session, prompt, {
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
      signal,
    });
    record.status = failure ? "error" : "completed";
    if (failure) record.error = failure;
    record.result = text;
    record.completedAt = Date.now();
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
    record.completedAt = Date.now();
  }

  deps.abortOwnedChildren(id);

  return record;
}

function startResume(
  deps: ResumeDeps,
  id: string,
  record: AgentRecord,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  options: ResumeOptions,
) {
  if (!record.session) return;

  record.status = "running";
  record.startedAt = Date.now();
  record.pool = occupiesPoolSlot(record) ? "background" : undefined;
  if (record.pool === "background") deps.acquireBackgroundSlot();
  deps.onStart?.(record);

  const abortController = new AbortController();
  record.abortController = abortController;
  let detachParentSignal: (() => void) | undefined;
  if (parentSignal) {
    const onParentAbort = () => deps.abort(id);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
  }

  try { options.onStarted?.(); } catch { }

  const settle = () => {
    if (record.settled) return;
    record.settled = true;
    detachParentSignal?.();
    detachParentSignal = undefined;
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { }
      record.outputCleanup = undefined;
    }
    deps.abortOwnedChildren(id);
    if (record.pool === "background") deps.releaseBackgroundSlot();
    try { deps.onComplete?.(record); } catch { }
    deps.drainQueue();
  };

  const promise = resumeAgent(record.session, prompt, {
    onToolActivity: (activity) => {
      if (activity.type === "end") record.toolUses++;
      deps.noteToolActivity(id, activity);
      options.onToolActivity?.(activity);
    },
    onAssistantUsage: (usage) => {
      addUsage(record.lifetimeUsage, usage);
      deps.onUsage?.(record, usage);
      options.onAssistantUsage?.(usage);
    },
    onCompaction: (info) => {
      record.compactionCount++;
      deps.onCompact?.(record, info);
      options.onCompaction?.(info);
    },
    signal: abortController.signal,
  })
    .then(({ text, failure }) => {
      if (record.status !== "stopped") {
        record.status = failure ? "error" : "completed";
        if (failure) record.error = failure;
      }
      record.result = text;
      record.completedAt ??= Date.now();
      settle();
      return text;
    })
    .catch((err) => {
      if (record.status !== "stopped") {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.completedAt ??= Date.now();
      settle();
      return "";
    });

  record.promise = promise;
}
