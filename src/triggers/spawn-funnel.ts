import { resolveSpawnType } from "../agents/agent-types.js";
import { resolveCapability } from "../config/capability-policy.js";
import { resolveEffectiveMaxTurns } from "../config/runner-defaults.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentConfig, AgentRecord } from "../types.js";

export interface SpawnFunnelDeps {
  manager: Pick<AgentManager, "spawn" | "getRecord" | "resolveMention">;
  reloadCustomAgents: (strict?: boolean) => void;
}

export interface SpawnFunnel {
  spawnResolved: (piRef: any, ctxRef: any, type: string, prompt: string, options: any, rawAgentConfig?: Partial<AgentConfig>) => string;
  spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any, rawAgentConfig?: Partial<AgentConfig>) => string;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
}

export function createSpawnFunnel(deps: SpawnFunnelDeps): SpawnFunnel {
  const { manager, reloadCustomAgents } = deps;

  const capabilityFor = (ctxRef: any, type: string, options: any, config?: AgentConfig, raw?: Partial<AgentConfig>) =>
    resolveCapability({
      type,
      cwd: ctxRef?.cwd ?? process.cwd(),
      config: config && { ...config, extensions: config.extensions ?? true, skills: config.skills ?? true },
      raw,
      isolated: options?.isolated,
      notify: (message, level) => ctxRef?.ui?.notify?.(message, level),
    });

  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any, rawAgentConfig?: Partial<AgentConfig>) => {
    const inline: AgentConfig | undefined = options?.agentConfig;
    if (inline) {
      return manager.spawn(piRef, ctxRef, type, prompt, {
        ...options,
        capability: capabilityFor(ctxRef, type, options, inline, rawAgentConfig ?? inline),
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns, inline),
      });
    }
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, {
      ...options,
      capability: capabilityFor(ctxRef, dispatch.type, options),
      maxTurns: options?.maxTurns ?? resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns),
    });
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any, rawAgentConfig?: Partial<AgentConfig>) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    delete safeOptions.rootSessionId;
    delete safeOptions.resumeSessionFile;
    delete safeOptions.reclaim;
    delete safeOptions.blocking;
    delete safeOptions.capability;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions, rawAgentConfig);
  };

  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  return { spawnResolved, spawnTopLevel, resolveAgentRef };
}
