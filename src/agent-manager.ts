// Size: AgentManager owns lifecycle state and delegates cohesive operations to adjacent modules.
/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_FOREGROUND, occupiesForegroundSlot, occupiesPoolSlot, type Pool } from "./agent-manager-rules.js";
import { type ResumeDeps, type ResumeOptions, resume as resumeOperation } from "./agent-resume.js";
import { cleanup as cleanupRecords, clearCompleted as clearCompletedRecords, dropTombstone as dropTombstoneEntry, takenHandles as getTakenHandles, listTombstones as listTombstoneEntries, type RetentionDeps, resolveMention as resolveAgentMention } from "./agent-retention.js";
import type { ToolActivity } from "./agent-runner.js";
import { shutdownChildSession } from "./agent-session-shutdown.js";
import { type SpawnArgs, type SpawnDeps, type SpawnOptions, spawnAgent, spawnAndWait as spawnAndWaitOperation } from "./agent-spawn.js";
import { armQueuedAbort as armQueuedAbortOperation, awaitStartup as awaitStartupOperation, launch as launchAgent, type StartDeps } from "./agent-start.js";
import type { NestedAgentManager } from "./nested-tools.js";
import type { AgentActivity, AgentRecord, AgentTombstone, MentionResolution, SubagentType } from "./types.js";
import type { LifetimeUsage } from "./usage.js";
import { pruneWorktrees } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Grace period `abort()` gives a running record to settle on its own before
 * forcing its settle tail — see `forceSettle`. A responsive agent settles
 * through its own promise in microseconds, hitting `settleRun`'s `settled`
 * guard well inside this window. Long enough for a child mid-stream to write
 * its final chunk and for `cleanupWorktree`'s `git worktree remove` to finish;
 * short enough that a leaked pool slot or a withheld notification returns
 * before anyone notices. Same order of magnitude as `CHILD_SHUTDOWN_TIMEOUT_MS`.
 */
const FORCED_SETTLE_GRACE_MS = 5_000;

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /**
   * Live activity per agent, keyed by record id.
   *
   * Owned here rather than by the UI because every spawn path runs through
   * `startAgent` — the Agent tool, a nested `Agent` call, a mention, the
   * scheduler, cross-extension RPC. The UI used to
   * build this only on the Agent-tool path, so a nested child's row had no
   * tool name and no turn count for its whole life.
   */
  private activities = new Map<string, AgentActivity>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  private retentionDeps(): RetentionDeps {
    return {
      agents: this.agents,
      activities: this.activities,
      startups: this.startups,
      tombstones: this.tombstones,
    };
  }

  private spawnDeps(): SpawnDeps {
    return {
      agents: this.agents,
      activities: this.activities,
      queue: this.queue,
      takenHandles: () => this.takenHandles(),
      poolFor: record => this.poolFor(record),
      poolHasRoom: pool => this.poolHasRoom(pool),
      armQueuedAbort: (id, signal) => this.armQueuedAbort(id, signal),
      launch: (id, record, args, pool) => this.launch(id, record, args, pool),
      awaitStartup: id => this.awaitStartup(id),
    };
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return spawnAgent(this.spawnDeps(), pi, ctx, type, prompt, options);
  }

  private startDeps(): StartDeps {
    return {
      agents: this.agents,
      activities: this.activities,
      startups: this.startups,
      worktreeRepos: this.worktreeRepos,
      poolFor: record => this.poolFor(record),
      drainQueue: () => this.drainQueue(),
      abort: id => this.abort(id),
      noteToolActivity: (id, activity) => this.noteToolActivity(id, activity),
      abortOwnedChildren: id => this.abortOwnedChildren(id),
      settleRun: (record, guardCallback, pool) => this.settleRun(record, guardCallback, pool),
      acquireSlot: pool => {
        if (pool === "background") this.runningBackground++;
        else if (pool === "foreground") this.runningForeground++;
      },
      releaseSlot: pool => {
        if (pool === "background") this.runningBackground--;
        else if (pool === "foreground") this.runningForeground--;
      },
      nestedManager: this as NestedAgentManager,
      onStart: record => this.onStart?.(record),
      onComplete: record => this.onComplete?.(record),
      onCompact: (record, info) => this.onCompact?.(record, info),
      onUsage: (record, usage) => this.onUsage?.(record, usage),
    };
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    return armQueuedAbortOperation(this.startDeps(), id, signal);
  }

  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    return launchAgent(this.startDeps(), id, record, args, queuedPool);
  }

  awaitStartup(id: string): Promise<void> {
    return awaitStartupOperation(this.startDeps(), id);
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and in `forceSettle`'s call into this method —
   * nowhere else. `abort()` itself only fires the controller and marks the
   * record stopped; decrementing there too would double-free once the real
   * or forced settle also ran — permanently lifting the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param pool the pool this run was CHARGED TO at start time — passed in, not
   *   recomputed, so a mid-run change to `maxConcurrentForeground` can't make
   *   the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    // A forced settle (see `forceSettle`) may already have released this
    // run's slot and notified — a late real settle arriving after that must
    // be a no-op, or the pool decrements twice and the parent is notified twice.
    if (record.settled) return;
    record.settled = true;
    if (!record.isBackground) record.resultConsumed = true;
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // The isBackground half reproduces the pre-pool condition exactly — a
    // background settle has always drained, even for a nested child that held
    // no slot — so that path is unchanged whether or not the foreground pool is
    // on. The `pool` half only adds the drain a freed FOREGROUND slot needs.
    // A drain with nothing freed is a no-op anyway, but "no-op" is a claim
    // about reachability, and matching the old condition needs no such claim.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * The settle tail for a record `abort()` fired but that never settles on
   * its own within `FORCED_SETTLE_GRACE_MS` — an agent wedged inside a tool
   * call whose `runAgent` promise may never resolve. Without this, `abort()`
   * leaves the pool slot held, the completion notification undelivered, and
   * any nested children running forever, none of which a wedged agent's own
   * promise will ever fix.
   *
   * `abortOwnedChildren` and the output-file flush are ordinarily done by the
   * real completion handler right before it calls `settleRun` (see the
   * `.then`/`.catch` tails in `startAgent`) — that handler may never run here,
   * so this does them itself. The release-and-notify tail is `settleRun`
   * itself, shared with the real path via the `settled` guard: whichever of
   * the two runs first wins, and the other is a no-op.
   */
  private forceSettle(record: AgentRecord): void {
    if (record.settled) return;
    this.abortOwnedChildren(record.id);
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    this.settleRun(record, true, record.pool);
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    return spawnAndWaitOperation(this.spawnDeps(), pi, ctx, type, prompt, options, onSpawned);
  }

  private resumeDeps(): ResumeDeps {
    return {
      agents: this.agents,
      activities: this.activities,
      queue: this.queue,
      poolHasRoom: pool => this.poolHasRoom(pool),
      acquireBackgroundSlot: () => { this.runningBackground++; },
      releaseBackgroundSlot: () => { this.runningBackground--; },
      abort: id => this.abort(id),
      drainQueue: () => this.drainQueue(),
      abortOwnedChildren: id => this.abortOwnedChildren(id),
      noteToolActivity: (id, activity) => this.noteToolActivity(id, activity),
      onStart: record => this.onStart?.(record),
      onComplete: record => this.onComplete?.(record),
      onCompact: (record, info) => this.onCompact?.(record, info),
      onUsage: (record, usage) => this.onUsage?.(record, usage),
    };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    return resumeOperation(this.resumeDeps(), id, prompt, signal, options);
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Live activity for an agent, for any surface that renders what it is doing. */
  getActivity(id: string): AgentActivity | undefined {
    return this.activities.get(id);
  }

  /**
   * Fold one tool event into an agent's activity state. Active tools are keyed
   * by name plus time because an agent can run two of the same tool at once,
   * and an `end` must clear exactly one of them.
   */
  private noteToolActivity(id: string, activity: ToolActivity): void {
    const state = this.activities.get(id);
    if (!state) return;
    if (activity.type === "start") {
      state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
      return;
    }
    for (const [key, name] of state.activeTools) {
      if (name === activity.toolName) { state.activeTools.delete(key); break; }
    }
    state.toolUses++;
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    return getTakenHandles(this.retentionDeps());
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    return resolveAgentMention(this.retentionDeps(), name);
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    dropTombstoneEntry(this.retentionDeps(), handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return listTombstoneEntries(this.retentionDeps());
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    // A responsive agent settles through its own promise in microseconds,
    // well inside this window, hitting `settleRun`'s `settled` guard before
    // this fires — see `forceSettle`. Unref'd: a wedged agent nobody stops
    // must not keep the process alive on its own, and this timer already only
    // exists because something else did stop it.
    const timer = setTimeout(() => this.forceSettle(record), FORCED_SETTLE_GRACE_MS);
    timer.unref?.();
    return true;
  }

  private cleanup(): void {
    cleanupRecords(this.retentionDeps());
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    clearCompletedRecords(this.retentionDeps(), skipUnconsumed);
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
