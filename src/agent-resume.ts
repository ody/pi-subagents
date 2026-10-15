import { occupiesPoolSlot, type Pool } from "./agent-manager-rules.js";
import { resumeAgent, type ToolActivity } from "./agent-runner.js";
import type { AgentActivity, AgentRecord } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";

export interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
  /**
   * The turn ceiling this resumed run was given, for display only — the run
   * itself gets it from the agent's own config. Omitted leaves the ceiling the
   * agent was originally spawned with.
   */
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

/** Resume an existing agent session with a new prompt. */
export async function resume(
  deps: ResumeDeps,
  id: string,
  prompt: string,
  signal?: AbortSignal,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  const record = deps.agents.get(id);
  if (!record?.session) return undefined;

  // A resumed turn starts from a clean activity slate. The session is seeded
  // here because a resume has no `onSessionCreated` — the session predates the
  // run — and without it the widget shows no context % for the agent.
  const activity = deps.activities.get(id);
  if (activity) {
    activity.activeTools.clear();
    activity.responseText = "";
    activity.turnCount = 1;
    activity.session = record.session;
    if (options?.maxTurns !== undefined) activity.maxTurns = options.maxTurns;
  }

  // Background resume: settle asynchronously and notify on completion exactly
  // like a background spawn, returning immediately with the record still
  // "running" — or "queued" when at the concurrency limit. Previously
  // run_in_background was ignored on resume (the Agent tool's resume branch
  // returned before its background branch, and resume() only ever awaited
  // inline), so a resumed agent always blocked the caller until it finished.
  if (options?.isBackground) {
    // Never re-enter a run that is still in flight. Detaching means the caller
    // gets control back while the record stays "running", so nothing stops the
    // model from resuming the same agent again. Starting a second run would
    // overwrite record.abortController — orphaning the live run beyond the
    // reach of `/agents` stop and abortAll() — double-count the pool slot, and
    // then reject from session.prompt() with "Agent is already processing",
    // whose settle path would abort the LIVE run's children and report a
    // failure for a run that is still going. Refuse instead, leaving the
    // record untouched; the caller decides whether to wait or steer.
    if (record.status === "running" || record.status === "queued") return undefined;

    record.isBackground = true;
    record.resultConsumed = false;
    record.result = undefined;
    record.error = undefined;
    record.completedAt = undefined;
    record.status = "queued";
    // A fresh run: the previous one's settle (real or forced) must not gate
    // this one's — the guard is per-run, and `settled` outlives the record.
    record.settled = false;

    const start = () => startResume(deps, id, record, prompt, signal, options);
    if (occupiesPoolSlot(record) && !deps.poolHasRoom("background")) {
      // At the concurrency limit — queue it, drains when a slot frees. A
      // detached resume has no inline caller, hence nothing to release. The
      // queue is shared with spawns, whose startup is async, so entries are
      // promise-shaped even though a resume starts synchronously; failures
      // land on the record here, since drainQueue no longer catches.
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

  // Foreground resume: run inline and return the settled record. Doesn't
  // read or write the pool slot, but a later background resume of the SAME
  // record must not inherit a stale latch from further back.
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
    // Same contract as the spawn path (#144): a failed final turn is an
    // error, not a completion — but the resumed text stays available.
    record.status = failure ? "error" : "completed";
    if (failure) record.error = failure;
    record.result = text;
    record.completedAt = Date.now();
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
    record.completedAt = Date.now();
  }

  // Same contract as the spawn settle paths: children spawned during the
  // resumed turn must not outlive it — nothing else can see or reach them.
  deps.abortOwnedChildren(id);

  return record;
}

/**
 * Start a background resume run: detached, settling and notifying like
 * startAgent's background path. Invoked immediately, or from drainQueue when
 * a concurrency slot frees. The session already exists (resume reuses it), so
 * there is no onSessionCreated to hang per-run wiring off — callers use
 * `options.onStarted`, which fires on both the immediate and the drained path.
 */
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
  // Stored, like `startAgent`'s, so a forced settle outside this closure
  // can release the same slot it acquired.
  record.pool = occupiesPoolSlot(record) ? "background" : undefined;
  if (record.pool === "background") deps.acquireBackgroundSlot();
  deps.onStart?.(record);

  // Fresh abort controller so /agents stop and steering target THIS run rather
  // than the previous one's settled controller.
  const abortController = new AbortController();
  record.abortController = abortController;
  // Optional, and NOT what the Agent tool passes for a detached resume: a
  // parent signal aborts on the parent's own interrupt (user Esc), which is
  // right for a foreground run whose result the caller is awaiting, and wrong
  // for a detached one — background spawns omit it for exactly this reason.
  let detachParentSignal: (() => void) | undefined;
  if (parentSignal) {
    const onParentAbort = () => deps.abort(id);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
  }

  // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
  // After the record is in its running shape, before the run is kicked off.
  try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

  const settle = () => {
    // Mirrors settleRun's guard: `forceSettle` may already have released
    // this run's slot and notified if the resume never settled on its own.
    if (record.settled) return;
    record.settled = true;
    detachParentSignal?.();
    detachParentSignal = undefined;
    // Final flush of streaming output file
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    // Children spawned during the resumed turn must not outlive it.
    deps.abortOwnedChildren(id);
    if (record.pool === "background") deps.releaseBackgroundSlot();
    try { deps.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
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
      // Don't overwrite status if externally stopped via abort().
      if (record.status !== "stopped") {
        // Same contract as the spawn path (#144): a failed final turn is an
        // error, not a completion — but the resumed text stays available.
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
