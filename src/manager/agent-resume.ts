import { normalizeMaxTurns } from "../config/runner-defaults.js";
import { resumeAgent, type ToolActivity } from "../session/agent-runner.js";
import type { AgentActivity, AgentRecord, StopCause } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import type { Pool } from "./agent-manager-rules.js";

export interface ResumeOptions {
  isBackground?: boolean;
  signalCause?: StopCause;
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
  signal?: AbortSignal,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  if (signal && !options?.signalCause) {
    throw new Error("A resume with a signal needs signalCause, the stop cause of the signal's owner.");
  }
  const record = deps.agents.get(id);
  if (!record?.session) return undefined;
  if (record.status === "running" || record.status === "queued" || (!record.settled && record.promise !== undefined)) return undefined;

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
  record.error = undefined;
  record.stopCause = undefined;
  record.completedAt = undefined;
  deps.reopenRun(record);
  record.pool = undefined;
  record.promise = undefined;
  record.startGate = undefined;
  record.outputCleanup = undefined;
  record.abortController = controller;
  record.detachParentSignal = watchParentSignal(deps, record, controller, signal, options?.signalCause);

  const begin = () => {
    try {
      startResume(deps, record, prompt, signal, options);
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
    let release!: () => void;
    record.startGate = new Promise<void>(resolve => { release = resolve; });
    deps.queue.push({
      id,
      pool,
      start: async () => {
        try { begin(); } catch { }
      },
      release: () => release(),
    });
  } else {
    begin();
  }

  if (isBackground) return record;
  if (record.status === "queued") await record.startGate;
  await record.promise;
  return record;
}

function watchParentSignal(
  deps: ResumeDeps,
  record: AgentRecord,
  controller: AbortController,
  parentSignal: AbortSignal | undefined,
  cause: StopCause | undefined,
): (() => void) | undefined {
  if (!parentSignal || !cause) return undefined;
  const onParentAbort = () => {
    if (record.abortController === controller) deps.abort(record.id, cause);
  };
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onParentAbort);
}

function startResume(
  deps: ResumeDeps,
  record: AgentRecord,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  options: ResumeOptions | undefined,
) {
  if (!record.session) return;
  const id = record.id;
  const controller = record.abortController!;
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
    .then(({ text, failure }) => {
      if (!isCurrent()) return text;
      if (record.status !== "stopped") {
        record.status = failure ? "error" : "completed";
        if (failure) record.error = failure;
      }
      record.result = text;
      record.completedAt ??= Date.now();
      deps.settleRun(record);
      return text;
    })
    .catch((err) => {
      if (!isCurrent()) return "";
      if (record.status !== "stopped") {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.completedAt ??= Date.now();
      deps.settleRun(record);
      return "";
    });
}
