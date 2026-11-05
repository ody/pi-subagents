import { describeModel } from "../config/model-resolver.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { runAgent, type ToolActivity } from "../session/agent-runner.js";
import type { NestedAgentManager } from "../tool/nested-tools.js";
import type { AgentActivity, AgentRecord } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import { assertValidSpawnCwd, type Pool } from "./agent-manager-rules.js";
import type { SpawnArgs } from "./agent-spawn.js";

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
        if (queuedPool === "foreground") record.resultConsumed = true;
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        deps.onComplete?.(record);
      } else {
        deps.agents.delete(id);
      }
      deps.drainQueue();
      throw err;
    },
  );
  deps.startups.set(id, startup);
  return startup.catch(() => {});
}

export function awaitStartup(deps: StartDeps, id: string): Promise<void> {
  return deps.startups.get(id) ?? Promise.resolve();
}

export async function startAgent(
  deps: StartDeps,
  id: string,
  record: AgentRecord,
  { pi, ctx, type, prompt, options }: SpawnArgs,
): Promise<void> {
  assertValidSpawnCwd(options.cwd);
  const customCwd = options.cwd ?? undefined;
  const baseCwd = customCwd ?? ctx.cwd;

  const pool = deps.poolFor(record);
  record.pool = pool;
  const releaseSlot = () => {
    record.settled = true;
    deps.releaseSlot(pool);
  };
  record.status = "running";
  record.startedAt = Date.now();
  record.startGate = undefined;
  deps.acquireSlot(pool);

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
    worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
    deps.worktreeRepos.add(baseCwd);

    if (record.status !== "running") {
      releaseSlot();
      record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
      deps.drainQueue();
      return;
    }
  }

  deps.onStart?.(record);

  let detachParentSignal: (() => void) | undefined;
  if (options.signal) {
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
    cwd: worktreeCwd ?? customCwd,
    worktreeBase: worktreeCwd ? baseCwd : undefined,
    configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
    signal: record.abortController!.signal,
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
      record.sessionFile = session.sessionManager?.getSessionFile?.();
      if (session.model) {
        record.invocation ??= {};
        const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
        Object.assign(record.invocation, describeModel(session.model));
        if (session.thinkingLevel) {
          record.invocation.thinking = session.thinkingLevel;
          if (requested && requested !== session.thinkingLevel) {
            record.invocation.requestedThinking = requested;
          }
        }
      }
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
      if (record.status !== "stopped") {
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

      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { }
        record.outputCleanup = undefined;
      }

      if (record.worktree) {
        const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
        record.worktreeResult = wtResult;
        if (wtResult.hasChanges && wtResult.branch) {
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
      if (record.status !== "stopped") {
        record.status = "error";
      }
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt ??= Date.now();

      detach();

      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { }
        record.outputCleanup = undefined;
      }

      if (record.worktree) {
        try {
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
        } catch { }
      }

      deps.abortOwnedChildren(id);

      deps.settleRun(record, false, pool);
      return "";
    });

  record.promise = promise;

  options.onSpawned?.(id);
}
