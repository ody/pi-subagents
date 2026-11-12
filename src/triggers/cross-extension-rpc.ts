import { policyEventPayload } from "../config/capability-policy-config.js";
import { type ModelRegistry, resolveModel } from "../config/model-resolver.js";
import { checkModelScope } from "../config/model-scope.js";
import { isTopLevelAgent } from "../manager/agent-manager-rules.js";
import type { AgentConfig, AgentRecord } from "../types.js";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

export const PROTOCOL_VERSION = 2;

export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  awaitStartup(id: string): Promise<void>;
  abort(id: string): boolean;
  getRecord(id: string): Pick<AgentRecord, "parentAgentId"> | undefined;
  consumeResult(id: string): boolean;
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
}

export function normalizeInlineAgentConfig(type: unknown, raw: unknown, description?: string): AgentConfig {
  if (typeof type !== "string" || !type.trim()) throw new Error("Inline agentConfig requires a type to name the run");
  const given = (raw ?? {}) as Partial<AgentConfig>;
  if (typeof raw !== "object" || typeof given.systemPrompt !== "string") {
    throw new Error("Inline agentConfig requires a systemPrompt string");
  }
  return {
    ...given,
    name: type,
    description: given.description ?? description ?? type,
    systemPrompt: given.systemPrompt,
    extensions: given.extensions ?? true,
    skills: given.skills ?? true,
    promptMode: given.promptMode ?? "replace",
  };
}

function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    const cwd = (getCtx() as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    return { version: PROTOCOL_VERSION, policy: policyEventPayload(cwd) };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", async ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      let normalizedOptions = options ?? {};
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            throw new Error(resolved);
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
        if (verdict.kind === "error") throw new Error(verdict.message);
      }

      if (normalizedOptions.agentConfig != null) {
        normalizedOptions = {
          ...normalizedOptions,
          agentConfig: normalizeInlineAgentConfig(type, normalizedOptions.agentConfig, normalizedOptions.description),
        };
      }

      const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
      await manager.awaitStartup(id);
      return { id };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      const record = manager.getRecord(agentId);
      if (!record) throw new Error("Agent not found");
      if (!isTopLevelAgent(record)) throw new Error("Agent is owned by another agent");
      if (!manager.abort(agentId)) throw new Error("Agent is not running");
    },
  );

  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:consume", ({ agentId }) => {
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume };
}
