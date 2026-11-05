import { resolveSpawnType } from "../agents/agent-types.js";
import { resolveEffectiveMaxTurns } from "../config/runner-defaults.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentConfig, AgentRecord } from "../types.js";

export interface SpawnFunnelDeps {
  manager: Pick<AgentManager, "spawn" | "getRecord" | "resolveMention">;
  reloadCustomAgents: (strict?: boolean) => void;
}

export interface SpawnFunnel {
  spawnResolved: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
}

export function createSpawnFunnel(deps: SpawnFunnelDeps): SpawnFunnel {
  const { manager, reloadCustomAgents } = deps;

  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const inline: AgentConfig | undefined = options?.agentConfig;
    if (inline) {
      return manager.spawn(piRef, ctxRef, type, prompt, {
        ...options,
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns, inline),
      });
    }
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, {
      ...options,
      maxTurns: options?.maxTurns ?? resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns),
    });
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    delete safeOptions.rootSessionId;
    delete safeOptions.resumeSessionFile;
    delete safeOptions.reclaim;
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  return { spawnResolved, spawnTopLevel, resolveAgentRef };
}
