import { describeModel } from "../config/model-resolver.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { runAgent, type ToolActivity } from "../session/agent-runner.js";
import type { NestedAgentManager } from "../tool/nested-tools.js";
import type { AgentActivity, AgentRecord, StopCause } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import { assertValidSpawnCwd, type Pool } from "./agent-manager-rules.js";
import type { SpawnArgs } from "./agent-spawn.js";
import { watchParentSignal } from "./parent-signal.js";
import { recordRunError, recordRunOutcome } from "./run-outcome.js";

export interface StartDeps {
  agents: Map<string, AgentRecord>;
  activities: Map<string, AgentActivity>;
  startups: Map<string, Promise<void>>;
  worktreeRepos: Set<string>;
  poolFor: (record: AgentRecord) => Pool | undefined;
  abort: (id: string, cause: StopCause) => boolean;
  noteToolActivity: (id: string, activity: ToolActivity) => void;
  settleRun: (record: AgentRecord) => void;
  acquireSlot: (pool: Pool | undefined) => void;
  nestedManager: NestedAgentManager;
  onStart?: (record: AgentRecord) => void;
  onCompact?: (record: AgentRecord, info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  onUsage?: (record: AgentRecord, usage: LifetimeUsage) => void;
}

export function launch(
  deps: StartDeps,
  id: string,
  record: AgentRecord,
  args: SpawnArgs,
  queued: boolean,
): Promise<void> {
  const startup = startAgent(deps, id, record, args).then(
    () => { deps.startups.delete(id); },
    (err) => {
      deps.startups.delete(id);
      recordRunError(record, err);
      if (!queued) record.resultConsumed = true;
      deps.settleRun(record);
      if (!queued) {
        deps.agents.delete(id);
        deps.activities.delete(id);
      }
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
  record.status = "running";
  record.startedAt = Date.now();
  record.startGate = undefined;
  deps.acquireSlot(pool);

  let worktreeCwd: string | undefined;
  if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
    const wt = await createWorktree(pi, baseCwd, id);
    if (!wt) {
      const failure = new Error(
        'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
        'Initialize git and commit at least once, or omit `isolation`.',
      );
      throw failure;
    }
    record.worktree = wt;
    worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
    deps.worktreeRepos.add(baseCwd);

    if (record.status !== "running") {
      record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
      deps.settleRun(record);
      return;
    }
  }

  deps.onStart?.(record);

  const controller = record.abortController!;
  record.detachParentSignal = watchParentSignal(deps.abort, record, controller, options.signal, options.signalCause);
  if (options.signal?.aborted) deps.abort(id, options.signalCause!);

  const isCurrent = () => record.abortController === controller;

  const promise = runAgent(ctx, type, prompt, {
    pi,
    agentId: id,
    agentConfig: options.agentConfig,
    capability: options.capability!,
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
    signal: controller.signal,
    notify: (message, level) => ctx.ui?.notify?.(message, level),
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
      if (isCurrent()) {
        recordRunOutcome(record, { text: responseText, aborted, steered, failure });
        record.session = session;
      }

      if (record.worktree) await saveWorktree(pi, baseCwd, customCwd, record, options.description);

      if (isCurrent()) deps.settleRun(record);
      return responseText;
    })
    .catch(async (err) => {
      if (isCurrent()) recordRunError(record, err);

      if (record.worktree) {
        try {
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
        } catch (cleanupErr) {
          record.worktreeResult = {
            hasChanges: false,
            path: record.worktree.path,
            failure: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          };
        }
      }

      if (isCurrent()) deps.settleRun(record);
      return "";
    });

  record.promise = promise;

  options.onSpawned?.(id);
}

async function saveWorktree(
  pi: SpawnArgs["pi"],
  baseCwd: string,
  customCwd: string | undefined,
  record: AgentRecord,
  description: string,
): Promise<void> {
  const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree!, description);
  record.worktreeResult = wtResult;
  if (wtResult.hasChanges && wtResult.branch) {
    const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
    record.result = (record.result ?? "") +
      `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
  } else if (wtResult.failure) {
    record.result = (record.result ?? "") +
      `\n\n---\nSaving the worktree changes failed: ${wtResult.failure}\nThe worktree stays at \`${wtResult.path}\`. Its changes are not on a branch.`;
  }
}
