import { assertValidSpawnCwd, type Pool } from "./agent-manager-rules.js";
import { runAgent, type ToolActivity } from "./agent-runner.js";
import type { SpawnArgs } from "./agent-spawn.js";
import { describeModel } from "./model-resolver.js";
import type { NestedAgentManager } from "./nested-tools.js";
import type { AgentActivity, AgentRecord } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "./worktree.js";

export interface StartDeps {
  agents: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity>;
  startups: Map<string, Promise<void>>;
  worktreeRepos: Set<string>;
  poolFor: (record: AgentRecord) => Pool | undefined;
  drainQueue: () => void;
  abort: (id: string) => boolean;
  noteToolActivity: (id: string, activity: ToolActivity) => void;
  abortOwnedChildren: (parentId: string) => void;
  settleRun: (record: AgentRecord, guardCallback: boolean, pool: Pool | undefined) => void;
  acquireSlot: (pool: Pool | undefined) => void;
  releaseSlot: (pool: Pool | undefined) => void;
  nestedManager: NestedAgentManager;
  onStart?: (record: AgentRecord) => void;
  onComplete?: (record: AgentRecord) => void;
  onCompact?: (record: AgentRecord, info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onUsage?: (record: AgentRecord, usage: LifetimeUsage) => void;
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
export function armQueuedAbort(deps: StartDeps, id: string, signal?: AbortSignal): boolean {
  if (signal === undefined) return true;
  if (signal.aborted) {
    const record = deps.agents.get(id);
    if (record) {
      record.status = "stopped";
      record.completedAt = Date.now();
    }
    return false;
  }
  signal.addEventListener("abort", () => deps.abort(id), { once: true });
  return true;
}

/**
 * Kick off an agent's startup and register it under `startups`. The returned
 * promise never rejects — the failure is delivered through `awaitStartup`,
 * and to the record.
 *
 * @param queuedPool - The pool this start was QUEUED on, or undefined for an
 *   immediate start. A queue drain can be minutes after `spawn()` returned,
 *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
 *   on the record as status "error" — what drainQueue did when the throw was
 *   still synchronous. An immediate start instead drops the record, exactly
 *   as the throw out of `spawn()` did: no orphan in `listAgents()`, and the
 *   handle goes back.
 */
export function launch(
  deps: StartDeps,
  id: string,
  record: AgentRecord,
  args: SpawnArgs,
  queuedPool: Pool | undefined,
): Promise<void> {
  const startup = startAgent(deps, id, record, args).then(
    () => { deps.startups.delete(id); },
    (err) => {
      deps.startups.delete(id);
      if (queuedPool !== undefined) {
        // Mirrors settleRun: an inline caller gets this failure as a throw
        // out of spawnAndWait, so an unconsumed record would ALSO nudge the
        // session about it — the same failure reported twice.
        if (queuedPool === "foreground") record.resultConsumed = true;
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        deps.onComplete?.(record);
      } else {
        deps.agents.delete(id);
      }
      // The agent never kept its slot (startAgent gives it back on failure),
      // so anything queued behind it can go now.
      deps.drainQueue();
      throw err;
    },
  );
  deps.startups.set(id, startup);
  // Nothing is obliged to await `startups` — swallow the rejection once here
  // so an unawaited startup can't take the process down, and hand callers
  // (drainQueue) that swallowed promise.
  return startup.catch(() => {});
}

/**
 * Resolves once the agent is actually running, and rejects with the startup
 * failure (strict worktree isolation) that `spawn()` used to throw before the
 * repo copy became async. Resolves immediately for an agent that is already
 * running, still queued, or unknown — so callers can await it unconditionally.
 *
 * Call it in the same tick as the `spawn()` it belongs to: a failed startup
 * takes its record (and this entry) with it, exactly as the throw did.
 */
export function awaitStartup(deps: StartDeps, id: string): Promise<void> {
  return deps.startups.get(id) ?? Promise.resolve();
}

/** Actually start an agent (called immediately or from queue drain). */
export async function startAgent(
  deps: StartDeps,
  id: string,
  record: AgentRecord,
  { pi, ctx, type, prompt, options }: SpawnArgs,
): Promise<void> {
  // Re-validate a caller-supplied cwd: queued spawns can start minutes after
  // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
  // curated errors; drainQueue parks a throw on the record as an error.
  assertValidSpawnCwd(options.cwd);
  // Single resolution point for the caller-supplied cwd — the worktree base
  // repo and both cleanup calls below MUST agree on this value forever.
  const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
  const baseCwd = customCwd ?? ctx.cwd;

  // Take the running state — and with it the concurrency slot — BEFORE the
  // first await. Creating a worktree is an awaited git call, and drainQueue
  // reads the pool counters synchronously in a loop: incrementing after the
  // await would let it start every queued agent at once while the first is
  // still copying its repo. Claiming "running" here also keeps abort() and
  // abortAll() able to reach an agent whose worktree is still being created.
  //
  // The pool is resolved ONCE, here, and carried to `settleRun` below:
  // `poolFor` reads `maxConcurrentForeground`, which the user can change from
  // `/agents → Settings` mid-run, so recomputing it at settle time would
  // decrement a pool this run never charged (counter underflow, limit
  // silently lifted) or skip the decrement for one it did (leaked slot —
  // every later blocking spawn queues forever). The two startup exits below
  // never reach `settleRun`, so they hand the slot back themselves.
  const pool = deps.poolFor(record);
  // Mirrored onto the record for `forceSettle`, which runs outside this
  // closure and cannot see `pool` — see the field's doc comment.
  record.pool = pool;
  const releaseSlot = () => {
    // Marked here, not only decremented: a startup failure exits before
    // this run ever gets a `promise` to settle, so if `abort()` armed the
    // forced-settle timer during the awaited worktree copy, that timer must
    // find the slot already gone rather than releasing it a second time.
    record.settled = true;
    deps.releaseSlot(pool);
  };
  record.status = "running";
  record.startedAt = Date.now();
  record.startGate = undefined;
  deps.acquireSlot(pool);

  // Worktree isolation: try to create a temporary git worktree. Strict —
  // fail loud if not possible (no silent fallback to main tree). Done BEFORE
  // the run is kicked off so a failure doesn't leave a half-running agent.
  // The project switch is enforced here as well as at the tool boundary
  // because cross-extension RPC forwards its options unvalidated — a schema
  // that omits the field can't stop a caller that never saw the schema.
  let worktreeCwd: string | undefined;
  if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
    const wt = await createWorktree(pi, baseCwd, id);
    if (!wt) {
      releaseSlot();
      throw new Error(
        'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
        'Initialize git and commit at least once, or omit `isolation`.',
      );
    }
    record.worktree = wt;
    // workPath preserves subdirectory scoping for caller-supplied cwds: a
    // cwd deep in a monorepo maps to the same subdir inside the copy, not
    // the copied repo's root. Plain worktree spawns keep the historical
    // behavior (agent at the copy's root) — moving them to workPath would
    // also move .pi config discovery when the parent session sits in a repo
    // subdirectory, silently dropping extensions/skills.
    worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
    deps.worktreeRepos.add(baseCwd);

    // No longer "running" means a stop landed while the copy was being made
    // (abort(), abortAll()) — a window that did not exist when creation was
    // synchronous. The record is already terminal, so launching the run would
    // burn tokens on work nobody is waiting for: discard the fresh (and by
    // definition unchanged) worktree instead.
    if (record.status !== "running") {
      releaseSlot();
      record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
      deps.drainQueue();
      return;
    }
  }

  deps.onStart?.(record);

  // Wire parent abort signal to stop the subagent when the parent is interrupted
  let detachParentSignal: (() => void) | undefined;
  if (options.signal) {
    // A queued spawn can start minutes after the caller handed us its signal,
    // by which time it may already be aborted — and `addEventListener` would
    // never fire, leaving a child the parent can no longer reach.
    if (options.signal.aborted) deps.abort(id);
    else {
      const onParentAbort = () => deps.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
  }
  const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

  const promise = runAgent(ctx, type, prompt, {
    pi,
    agentId: id,
    agentConfig: options.agentConfig,
    model: options.model,
    maxTurns: options.maxTurns,
    isolated: options.isolated,
    inheritContext: options.inheritContext,
    thinkingLevel: options.thinkingLevel,
    resumeSessionFile: options.resumeSessionFile,
    nested: options.parentAgentId !== undefined,
    // Worktree wins for the working dir (the agent must run in the copy —
    // which, with a custom cwd, was created from that target). Config stays
    // with the parent project when a caller-supplied cwd is in play; it must
    // stay undefined otherwise so plain worktree runs keep resolving config
    // (incl. relative extension paths and memory) inside the worktree copy.
    cwd: worktreeCwd ?? customCwd,
    // Set iff a worktree was created (see above) — names the directory the
    // copy came from, so the prompt can tell the agent not to work there.
    worktreeBase: worktreeCwd ? baseCwd : undefined,
    configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
    signal: record.abortController!.signal,
    // Each of these updates the manager's own activity state before the
    // caller's callback runs, so a caller that supplies none (a nested spawn)
    // still gets a fully tracked agent.
    onToolActivity: (activity) => {
      if (activity.type === "end") record.toolUses++;
      deps.noteToolActivity(id, activity);
      options.onToolActivity?.(activity);
    },
    onTurnEnd: (turnCount) => {
      const state = deps.activities.get(id);
      if (state) state.turnCount = turnCount;
      options.onTurnEnd?.(turnCount);
    },
    onTextDelta: (delta, fullText) => {
      const state = deps.activities.get(id);
      if (state) state.responseText = fullText;
      options.onTextDelta?.(delta, fullText);
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
    nestedRuntime: {
      manager: deps.nestedManager,
      parentAgentId: id,
      depth: record.depth ?? 1,
      maxSubagentDepth: record.maxSubagentDepth,
    },
    onSessionCreated: (session) => {
      record.session = session;
      const state = deps.activities.get(id);
      if (state) state.session = session;
      // Capture now, while the session object exists: after eviction this
      // path is the only thing that can reopen the conversation, and an
      // in-memory session reports undefined, which correctly means
      // "nothing to come back to".
      // Optional chaining, not defensiveness for its own sake: this is the
      // only field read off the session at creation, so an older pi or a
      // stubbed session must degrade to "not resumable" rather than throw
      // and take the whole spawn down with it.
      record.sessionFile = session.sessionManager?.getSessionFile?.();
      // Same reason, different field: the model and thinking level are only
      // knowable once pi has resolved its defaults and clamped the level to
      // what the model supports. Writing them back here makes the record
      // authoritative, so every surface reads one place instead of each
      // re-deriving "session, else the request" for itself.
      if (session.model) {
        record.invocation ??= {};
        // Read the kept request first: a caller's level survives being clamped
        // AND, one line later, being replaced by the effective one.
        const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
        Object.assign(record.invocation, describeModel(session.model));
        // Guarded for the reason above: a session that reports no level keeps
        // the request rather than losing it. Overwriting unconditionally would
        // turn an older or stubbed session into a blank `thinking:` tag, which
        // is worse than the stale-but-true value it replaced.
        if (session.thinkingLevel) {
          record.invocation.thinking = session.thinkingLevel;
          if (requested && requested !== session.thinkingLevel) {
            record.invocation.requestedThinking = requested;
          }
        }
      }
      // Flush any steers that arrived before the session was ready
      if (record.pendingSteers?.length) {
        for (const msg of record.pendingSteers) {
          session.steer(msg).catch(() => {});
        }
        record.pendingSteers = undefined;
      }
      options.onSessionCreated?.(session);
    },
  })
    .then(async ({ responseText, session, aborted, steered, failure }) => {
      // Don't overwrite status if externally stopped via abort()
      if (record.status !== "stopped") {
        // Precedence: a hard abort keeps "aborted"; then a failed final turn
        // (provider error that pi resolved instead of rejecting, #144) is an
        // honest "error" — not a completion with an empty or stale result.
        if (aborted) {
          record.status = "aborted";
        } else if (failure) {
          record.status = "error";
          record.error = failure;
        } else {
          record.status = steered ? "steered" : "completed";
        }
      }
      record.result = responseText;
      record.session = session;
      record.completedAt ??= Date.now();

      detach();

      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }

      // Clean up worktree if used
      if (record.worktree) {
        const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
        record.worktreeResult = wtResult;
        if (wtResult.hasChanges && wtResult.branch) {
          // With a caller-supplied cwd the branch lives in THAT repo, not the
          // parent session's — say so, or the orchestrator merges in the wrong repo.
          const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
          record.result = (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
        }
      }

      deps.abortOwnedChildren(id);

      deps.settleRun(record, true, pool);
      return responseText;
    })
    .catch(async (err) => {
      // Don't overwrite status if externally stopped via abort()
      if (record.status !== "stopped") {
        record.status = "error";
      }
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt ??= Date.now();

      detach();

      // Final flush of streaming output file on error
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }

      // Best-effort worktree cleanup on error
      if (record.worktree) {
        try {
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
        } catch { /* ignore cleanup errors */ }
      }

      deps.abortOwnedChildren(id);

      deps.settleRun(record, false, pool);
      return "";
    });

  record.promise = promise;

  // Notify caller that spawn is complete (record is in the map, promise is set).
  // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
  // Used by spawnAndWait to let the caller set up output files before streaming
  // starts. Read off the options, so a spawn that started from a queue drain
  // still reaches the caller that queued it.
  options.onSpawned?.(id);
}
