import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertValidSpawnCwd, isTopLevelAgent, type Pool } from "./agent-manager-rules.js";
import type { ToolActivity } from "./agent-runner.js";
import { assignHandle, handleBase } from "./mention.js";
import type { AgentActivity, AgentConfig, AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  /**
   * Run under this definition instead of the registry entry for `type`, which
   * then only names the run (handle, session name, record). Never added to the
   * registry, so it is invisible to the `Agent` tool and `/agents`.
   */
  agentConfig?: AgentConfig;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface SpawnQueueEntry {
  id: string;
  pool: Pool;
  start: () => Promise<void>;
  release: () => void;
}

export interface SpawnDeps {
  agents: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity>;
  queue: SpawnQueueEntry[];
  takenHandles: () => Set<string>;
  poolFor: (record: AgentRecord) => Pool | undefined;
  poolHasRoom: (pool: Pool) => boolean;
  armQueuedAbort: (id: string, signal?: AbortSignal) => boolean;
  launch: (id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined) => Promise<void>;
  awaitStartup: (id: string) => Promise<void>;
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
export function spawnAgent(
  deps: SpawnDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
): string {
  // Validate before the queue branch — a queued spawn should fail at the
  // call, not minutes later at drain. Throw (not warn): programmatic callers
  // can fix and retry; the RPC layer converts throws into error envelopes.
  assertValidSpawnCwd(options.cwd);

  const id = randomUUID().slice(0, 17);
  const abortController = new AbortController();
  const record: AgentRecord = {
    id,
    type,
    // Owned (nested) children are filtered out of every
    // top-level surface, so no handle: nothing can address them and they must
    // not consume a name a top-level sibling could otherwise take.
    handle: !isTopLevelAgent(options)
      ? undefined
      // A reclaimed handle is used as-is: it belongs to the conversation this
      // spawn is reopening, and re-deriving it would lose the numbering.
      : options.reclaim?.handle ?? assignHandle(handleBase(type), deps.takenHandles()),
    description: options.description,
    // Reclaimed here, or filled in below from `name` — in which case it must
    // see the handle this record just took, since both come out of the same
    // namespace.
    alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
    // Overwritten below when the spawn is actually queued; a foreground spawn
    // that queues flips to "queued" there rather than being guessed at here,
    // since the pool decision needs the finished record.
    status: options.isBackground ? "queued" : "running",
    toolUses: 0,
    startedAt: Date.now(),
    abortController,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    // Raw tri-state (not coerced to a boolean): true = background, false =
    // foreground (has an inline tool-result surface), undefined = caller never
    // declared it (e.g. a cross-extension RPC spawn). The widget's background-
    // only filter excludes only explicit `false`, so undefined agents — which
    // have no inline surface — stay visible instead of vanishing.
    isBackground: options.isBackground,
    // Whether anyone is awaiting this agent is a property of the agent, not
    // of the call that made it — and both settle paths need it long after
    // `options` has stopped being the interesting object.
    blocking: options.blocking,
    invocation: options.invocation,
    depth: options.depth ?? 1,
    parentAgentId: options.parentAgentId,
    maxSubagentDepth: options.maxSubagentDepth,
    rootSessionId: options.rootSessionId,
  };
  deps.agents.set(id, record);
  // Created at spawn, not at start: a queued record is already displayed, and
  // a surface reading its activity should get zeros rather than nothing.
  deps.activities.set(id, {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns: options.maxTurns,
    responseText: "",
    session: undefined,
  });
  // After the insert, so `takenHandles()` already counts this record's own
  // handle — a spawn named after its own type gets `explore-2`, not a
  // duplicate `explore` that would make resolution ambiguous.
  if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
    record.alias = assignHandle(handleBase(options.name), deps.takenHandles());
  }

  const args: SpawnArgs = { pi, ctx, type, prompt, options };

  const pool = deps.poolFor(record);
  if (pool !== undefined && !options.bypassQueue && !deps.poolHasRoom(pool)) {
    // Queue it — started when a running agent in the same pool completes.
    // Idempotent for background (already "queued"); the flip that matters is
    // a blocking foreground spawn, optimistically marked "running" above.
    record.status = "queued";
    // A queued record never reaches startAgent's signal wiring, so arm the
    // parent abort here or Esc could not release the position.
    if (!deps.armQueuedAbort(id, options.signal)) return id;
    let release!: () => void;
    record.startGate = new Promise<void>(resolve => { release = resolve; });
    deps.queue.push({
      id,
      pool,
      start: () => deps.launch(id, record, args, pool),
      release: () => release(),
    });
    options.onQueued?.(id, deps.queue.filter(e => e.pool === pool).length - 1);
    return id;
  }

  deps.launch(id, record, args, undefined);
  return id;
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
export async function spawnAndWait(
  deps: SpawnDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: Omit<SpawnOptions, "isBackground">,
  onSpawned?: (id: string) => void,
): Promise<{ id: string; record: AgentRecord }> {
  // `blocking` is what maxConcurrentForeground bounds, and this is its only
  // source. onSpawned rides on the options rather than on a field of this
  // manager: a queued spawn starts at drain time, long after any install/
  // restore pair around this call would have put the field back — and it now
  // fires after an await (worktree creation) even on the immediate path.
  const id = spawnAgent(deps, pi, ctx, type, prompt, {
    ...options,
    isBackground: false,
    blocking: true,
    onSpawned,
  });
  const record = deps.agents.get(id)!;

  // Queued: nothing to await yet — the promise appears when the drain starts
  // it. The gate resolves (never rejects) on every path out of the queue,
  // start and abort alike, so a rejection can never escape into the caller's
  // tool `execute` and take down pi's whole Promise.all tool batch.
  if (record.status === "queued") await record.startGate;

  // The run promise only exists once startup is past its awaited repo copy —
  // without this the call would return before the agent had started at all.
  // A startup failure (strict worktree isolation) rejects here, which is what
  // the immediate path owes its caller: pi only marks a tool result failed
  // when `execute` throws. A queued spawn's failure landed on the record
  // instead (nobody was awaiting `startups` at drain time) and is rethrown
  // below, so the contract is the same either way.
  await deps.awaitStartup(id);

  // undefined when it was aborted while queued, or stopped mid-copy, and so
  // never ran — the record is already terminal with a completedAt, which is
  // what the caller renders.
  if (record.promise) await record.promise;

  // A record that ended "error" without ever getting a promise never ran: the
  // same startup failure spawn() rethrows on the immediate path (#179). Keep
  // one contract rather than letting queue pressure decide whether a strict
  // worktree failure throws or returns as a result.
  if (record.promise === undefined && record.status === "error") {
    throw new Error(record.error ?? "Agent failed to start");
  }
  return { id, record };
}
