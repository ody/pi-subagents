import { getAgentConfig, resolveSpawnType } from "../agents/agent-types.js";
import { resolveCapability } from "../config/capability-policy.js";
import { resolveModel } from "../config/model-resolver.js";
import { scopeModel } from "../config/model-scope.js";
import { resolveEffectiveMaxTurns } from "../config/runner-defaults.js";
import type { AgentManager } from "../manager/agent-manager.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { resolveIsolation } from "../tool/invocation-config.js";
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

function resolvePin(registry: any, callerModel: any, configModel: string | undefined): { pinned: any; modelInput: string | undefined } {
  if (typeof callerModel === "string") {
    const resolved = registry ? resolveModel(callerModel, registry) : callerModel;
    if (typeof resolved === "string") throw new Error(resolved);
    return { pinned: resolved, modelInput: callerModel };
  }
  if (callerModel != null) return { pinned: callerModel, modelInput: `${callerModel.provider}/${callerModel.id}` };
  if (!configModel || !registry) return { pinned: undefined, modelInput: configModel };
  const resolved = resolveModel(configModel, registry);
  return { pinned: typeof resolved === "string" ? undefined : resolved, modelInput: configModel };
}

export function createSpawnFunnel(deps: SpawnFunnelDeps): SpawnFunnel {
  const { manager, reloadCustomAgents } = deps;

  const capabilityFor = (ctxRef: any, type: string, options: any, config?: AgentConfig, raw?: Partial<AgentConfig>, ephemeral?: boolean) =>
    resolveCapability({
      type,
      cwd: ctxRef?.cwd ?? process.cwd(),
      config: config && { ...config, extensions: config.extensions ?? true, skills: config.skills ?? true },
      raw,
      ephemeral,
      isolated: options?.isolated,
      notify: (message, level) => ctxRef?.ui?.notify?.(message, level),
    });

  const scopedOptions = (ctxRef: any, label: string, options: any, configModel: string | undefined) => {
    const registry = ctxRef?.modelRegistry;
    const callerModel = options?.model;
    const { pinned, modelInput } = resolvePin(registry, callerModel, configModel);
    if (pinned == null || !registry) return options;
    const scoped = scopeModel({
      pinned,
      sessionModel: ctxRef.model,
      cwd: ctxRef.cwd ?? process.cwd(),
      modelRegistry: registry,
      callerSupplied: callerModel != null,
      agentLabel: label,
      modelInput,
    });
    if (!scoped.ok) throw new Error(scoped.message);
    if (scoped.replaced === undefined) return callerModel === pinned ? options : { ...options, model: pinned };
    ctxRef.ui?.notify?.(scoped.notice, "warning");
    return { ...options, model: scoped.model, modelReplaced: scoped.replaced };
  };

  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, rawOptions: any, rawAgentConfig?: Partial<AgentConfig>) => {
    const inline: AgentConfig | undefined = rawOptions?.agentConfig;
    if (inline) {
      const options = scopedOptions(ctxRef, inline.displayName ?? type, rawOptions, inline.model);
      return manager.spawn(piRef, ctxRef, type, prompt, {
        ...options,
        capability: capabilityFor(ctxRef, type, options, inline, rawAgentConfig ?? (options.ephemeral ? undefined : inline), Boolean(options.ephemeral)),
        isolation: resolveIsolation(inline.isolation, options?.isolation, isWorktreeIsolationEnabled()),
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns, inline),
      });
    }
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    const config = getAgentConfig(dispatch.type);
    const options = scopedOptions(ctxRef, config?.displayName ?? dispatch.type, rawOptions, config?.model);
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, {
      ...options,
      capability: capabilityFor(ctxRef, dispatch.type, options),
      isolation: resolveIsolation(getAgentConfig(dispatch.type)?.isolation, options?.isolation, isWorktreeIsolationEnabled()),
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
    delete safeOptions.ephemeral;
    delete safeOptions.modelReplaced;
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
