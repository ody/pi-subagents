import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type GrantedCapability, isMintedVerdict } from "../config/capability-policy.js";
import { normalizeMaxTurns } from "../config/runner-defaults.js";
import type { ToolActivity } from "../session/agent-runner.js";
import { assignHandle, handleBase } from "../triggers/mention.js";
import type { AgentActivity, AgentConfig, AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "../types.js";
import { assertValidSpawnCwd, isTopLevelAgent, type Pool } from "./agent-manager-rules.js";

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  name?: string;
  resumeSessionFile?: string;
  reclaim?: { handle: string; alias?: string };
  agentConfig?: AgentConfig;
  ephemeral?: { handleSeed: string };
  capability?: GrantedCapability;
  model?: Model<any>;
  modelReplaced?: string;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  blocking?: boolean;
  isolation?: IsolationMode;
  cwd?: string;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onSpawned?: (id: string) => void;
  onQueued?: (id: string, ahead: number) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  depth?: number;
  parentAgentId?: string;
  maxSubagentDepth?: number;
  configCwd?: string;
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

export function spawnAgent(
  deps: SpawnDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
): string {
  assertValidSpawnCwd(options.cwd);
  if (!isMintedVerdict(options.capability)) {
    throw new Error("Capability policy: a spawn needs a verdict from checkCapabilityPolicy.");
  }

  const id = randomUUID().slice(0, 17);
  const abortController = new AbortController();
  const record: AgentRecord = {
    id,
    type,
    handle: !isTopLevelAgent(options)
      ? undefined
      : options.reclaim?.handle ?? assignHandle(handleBase(options.ephemeral?.handleSeed ?? type), deps.takenHandles()),
    displayName: options.ephemeral ? options.agentConfig?.displayName : undefined,
    promptMode: options.ephemeral ? options.agentConfig?.promptMode : undefined,
    agentConfig: options.ephemeral ? options.agentConfig : undefined,
    description: options.description,
    alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
    status: options.isBackground ? "queued" : "running",
    toolUses: 0,
    startedAt: Date.now(),
    abortController,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    isBackground: options.isBackground,
    blocking: options.blocking,
    invocation: options.invocation,
    depth: options.depth ?? 1,
    parentAgentId: options.parentAgentId,
    maxSubagentDepth: options.maxSubagentDepth,
    rootSessionId: options.rootSessionId,
    filtered: options.capability.filtered.length > 0 ? options.capability.filtered : undefined,
    modelReplaced: options.modelReplaced,
    capabilities: options.capability.capabilities,
  };
  deps.agents.set(id, record);
  deps.activities.set(id, {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns: normalizeMaxTurns(options.maxTurns),
    responseText: "",
    session: undefined,
  });
  if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
    record.alias = assignHandle(handleBase(options.name), deps.takenHandles());
  }

  const args: SpawnArgs = { pi, ctx, type, prompt, options };

  const pool = deps.poolFor(record);
  if (pool !== undefined && !options.bypassQueue && !deps.poolHasRoom(pool)) {
    record.status = "queued";
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

export async function spawnAndWait(
  deps: SpawnDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: Omit<SpawnOptions, "isBackground">,
  onSpawned?: (id: string) => void,
): Promise<{ id: string; record: AgentRecord }> {
  const id = spawnAgent(deps, pi, ctx, type, prompt, {
    ...options,
    isBackground: false,
    blocking: true,
    onSpawned,
  });
  const record = deps.agents.get(id)!;

  if (record.status === "queued") await record.startGate;

  await deps.awaitStartup(id);

  if (record.promise) await record.promise;

  if (record.promise === undefined && record.status === "error") {
    throw new Error(record.error ?? "Agent failed to start");
  }
  return { id, record };
}
