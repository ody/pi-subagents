// Size: AgentManager owns lifecycle state and delegates cohesive operations to adjacent modules.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pruneWorktrees } from "../platform/worktree.js";
import type { ToolActivity } from "../session/agent-runner.js";
import { shutdownChildSession } from "../session/agent-session-shutdown.js";
import type { NestedAgentManager } from "../tool/nested-tools.js";
import type { AgentActivity, AgentRecord, AgentTombstone, MentionResolution, SubagentType } from "../types.js";
import type { LifetimeUsage } from "../usage.js";
import { DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_FOREGROUND, occupiesForegroundSlot, occupiesPoolSlot, type Pool } from "./agent-manager-rules.js";
import { type ResumeDeps, type ResumeOptions, resume as resumeOperation } from "./agent-resume.js";
import { cleanup as cleanupRecords, clearCompleted as clearCompletedRecords, dropTombstone as dropTombstoneEntry, takenHandles as getTakenHandles, listTombstones as listTombstoneEntries, type RetentionDeps, resolveMention as resolveAgentMention } from "./agent-retention.js";
import { type SpawnArgs, type SpawnDeps, type SpawnOptions, spawnAgent, spawnAndWait as spawnAndWaitOperation } from "./agent-spawn.js";
import { armQueuedAbort as armQueuedAbortOperation, awaitStartup as awaitStartupOperation, launch as launchAgent, type StartDeps } from "./agent-start.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

const FORCED_SETTLE_GRACE_MS = 5_000;

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private activities = new Map<string, AgentActivity>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  private worktreeRepos = new Set<string>();

  private startups = new Map<string, Promise<void>>();

  private tombstones = new Map<string, AgentTombstone>();

  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];
  private runningBackground = 0;
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
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrentForeground(n: number) {
    this.maxConcurrentForeground = Math.max(0, n);
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

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

  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    return armQueuedAbortOperation(this.startDeps(), id, signal);
  }

  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    return launchAgent(this.startDeps(), id, record, args, queuedPool);
  }

  awaitStartup(id: string): Promise<void> {
    return awaitStartupOperation(this.startDeps(), id);
  }

  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    if (record.settled) return;
    record.settled = true;
    if (!record.isBackground) record.resultConsumed = true;
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;

    if (guardCallback) {
      try { this.onComplete?.(record); } catch {}
    } else {
      this.onComplete?.(record);
    }

    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  private forceSettle(record: AgentRecord): void {
    if (record.settled) return;
    this.abortOwnedChildren(record.id);
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch {}
      record.outputCleanup = undefined;
    }
    if (record.result === undefined) {
      const streamed = this.getActivity(record.id)?.responseText.trim();
      if (streamed) record.result = streamed;
    }
    this.settleRun(record, true, record.pool);
  }

  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") { next.release(); continue; }
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

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

  resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    return resumeOperation(this.resumeDeps(), id, prompt, signal, options);
  }

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

  getActivity(id: string): AgentActivity | undefined {
    return this.activities.get(id);
  }

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

  private takenHandles(): Set<string> {
    return getTakenHandles(this.retentionDeps());
  }

  resolveMention(name: string): MentionResolution | undefined {
    return resolveAgentMention(this.retentionDeps(), name);
  }

  dropTombstone(handle: string): void {
    dropTombstoneEntry(this.retentionDeps(), handle);
  }

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
    const timer = setTimeout(() => this.forceSettle(record), FORCED_SETTLE_GRACE_MS);
    timer.unref?.();
    return true;
  }

  private cleanup(): void {
    cleanupRecords(this.retentionDeps());
  }

  clearCompleted(skipUnconsumed = false): void {
    clearCompletedRecords(this.retentionDeps(), skipUnconsumed);
  }

  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  abortAll(): number {
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
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

  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    if (pi) {
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      for (const repo of this.worktreeRepos) prune(repo);
    }
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
