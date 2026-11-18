import { policyEventPayload } from "../config/capability-policy-config.js";
import { type ModelRegistry, resolveModel } from "../config/model-resolver.js";
import { checkModelScope } from "../config/model-scope.js";
import { isTopLevelAgent } from "../manager/agent-manager-rules.js";
import type { SpawnOptions } from "../manager/agent-spawn.js";
import { RpcError, type RpcErrorCode } from "../rpc-error.js";
import type { AgentConfig, AgentRecord, StopCause } from "../types.js";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; code: RpcErrorCode; error: string };

export const PROTOCOL_VERSION = 2;

export const RPC_SPAWN_OPTIONS = [
  "description",
  "name",
  "agentConfig",
  "model",
  "maxTurns",
  "isolated",
  "inheritContext",
  "thinkingLevel",
  "isBackground",
  "isolation",
  "cwd",
  "signal",
  "onSpawned",
  "onQueued",
  "onCompaction",
  "onToolActivity",
  "onTextDelta",
  "onTurnEnd",
  "onAssistantUsage",
] as const satisfies readonly (keyof SpawnOptions)[];

const rpcSpawnOptionSet: ReadonlySet<string> = new Set(RPC_SPAWN_OPTIONS);

export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any, rawAgentConfig?: Partial<AgentConfig>): string;
  awaitStartup(id: string): Promise<void>;
  abort(id: string, cause: StopCause): boolean;
  getRecord(id: string): Pick<AgentRecord, "parentAgentId" | "filtered" | "modelReplaced" | "stopCause"> | undefined;
  consumeResult(id: string): void;
  waitIdle(): Promise<void>;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;
  getCtx: () => unknown | undefined;
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
  unsubWaitIdle: () => void;
  releaseWaiters: () => void;
}

export function normalizeInlineAgentConfig(type: unknown, raw: unknown, description?: string): AgentConfig {
  if (typeof type !== "string" || !type.trim()) throw new RpcError("invalid_agent_config", "Inline agentConfig requires a type to name the run");
  const given = (raw ?? {}) as Partial<AgentConfig>;
  if (typeof raw !== "object" || typeof given.systemPrompt !== "string") {
    throw new RpcError("invalid_agent_config", "Inline agentConfig requires a systemPrompt string");
  }
  return {
    ...given,
    name: type,
    description: given.description ?? description ?? type,
    systemPrompt: given.systemPrompt,
    extensions: given.extensions ?? true,
    skills: given.skills ?? true,
    promptMode: given.promptMode ?? "replace",
    persistSession: given.persistSession === true,
  };
}

function assertKnownOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (!rpcSpawnOptionSet.has(key)) throw new RpcError("unknown_option", `Unknown spawn option "${key}"`);
  }
}

function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    if (typeof params?.requestId !== "string" || params.requestId === "") return;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false,
        code: err instanceof RpcError ? err.code : "internal",
        error: err?.message ?? String(err),
      });
    }
  });
}

export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "agent:rpc:ping", () => {
    const cwd = (getCtx() as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    return { version: PROTOCOL_VERSION, policy: policyEventPayload(cwd) };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "agent:rpc:spawn", async ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new RpcError("no_session", "No active session");

      let normalizedOptions = options ?? {};
      assertKnownOptions(normalizedOptions);
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new RpcError("model_registry_unavailable", `Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            throw new RpcError("model_not_found", resolved);
          }
          model = resolved;
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        const verdict = checkModelScope({
          model,
          cwd: cwd ?? process.cwd(),
          modelRegistry,
          callerSupplied: true,
          agentLabel: type,
          modelInput: label,
        });
        if (verdict.kind === "error") throw new RpcError("model_out_of_scope", verdict.message);
      }

      const rawAgentConfig: Partial<AgentConfig> | undefined = normalizedOptions.agentConfig ?? undefined;
      if (normalizedOptions.agentConfig != null) {
        normalizedOptions = {
          ...normalizedOptions,
          agentConfig: normalizeInlineAgentConfig(type, normalizedOptions.agentConfig, normalizedOptions.description),
        };
      }

      const id = rawAgentConfig === undefined
        ? manager.spawn(pi, ctx, type, prompt, normalizedOptions)
        : manager.spawn(pi, ctx, type, prompt, normalizedOptions, rawAgentConfig);
      await manager.awaitStartup(id);
      const { filtered, modelReplaced } = manager.getRecord(id) ?? {};
      return { id, ...(filtered && { filtered }), ...(modelReplaced && { modelReplaced }) };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "agent:rpc:stop", ({ agentId }) => {
      const record = manager.getRecord(agentId);
      if (!record) throw new RpcError("not_found", "Agent not found");
      if (!isTopLevelAgent(record)) throw new RpcError("not_owned", "Agent is owned by another agent");
      if (!manager.abort(agentId, "extension")) throw new RpcError("not_running", "Agent is not running");
    },
  );

  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "agent:rpc:consume", ({ agentId }) => {
      manager.consumeResult(agentId);
    },
  );

  const idleWaiters = new Set<(err: RpcError) => void>();
  const unsubWaitIdle = handleRpc(events, "agent:rpc:wait_idle", () =>
    new Promise<void>((resolve, reject) => {
      idleWaiters.add(reject);
      manager.waitIdle().then(resolve, reject).finally(() => idleWaiters.delete(reject));
    }),
  );
  const releaseWaiters = () => {
    for (const reject of idleWaiters) reject(new RpcError("shutdown", "Session shut down before agents went idle"));
    idleWaiters.clear();
  };

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubWaitIdle, releaseWaiters };
}
