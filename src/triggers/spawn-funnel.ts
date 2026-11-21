import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, resolveSpawnType } from "../agents/agent-types.js";
import { resolveCapability } from "../config/capability-policy.js";
import { type ModelRegistry, resolveModel } from "../config/model-resolver.js";
import { scopeModel } from "../config/model-scope.js";
import { resolveEffectiveMaxTurns } from "../config/runner-defaults.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { SpawnOptions } from "../manager/agent-spawn.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { RpcError } from "../rpc-error.js";
import { resolveIsolation } from "../tool/invocation-config.js";
import type { AgentConfig, AgentRecord } from "../types.js";

export interface SpawnFunnelDeps {
  manager: Pick<AgentManager, "spawn" | "getRecord" | "resolveMention">;
  reloadCustomAgents: (strict?: boolean) => void;
}

type OptionalSpawnOptions = Partial<Omit<SpawnOptions, "model">>;

export type FunnelOptions = OptionalSpawnOptions & { model?: Model<Api> | string };

type ScopedOptions = OptionalSpawnOptions & { model?: Model<Api> };

export type FunnelSpawn = (
  piRef: ExtensionAPI,
  ctxRef: ExtensionContext,
  type: string,
  prompt: string,
  options: FunnelOptions,
  rawAgentConfig?: Partial<AgentConfig>,
) => string;

export interface SpawnFunnel {
  spawnResolved: FunnelSpawn;
  spawnTopLevel: FunnelSpawn;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
}

function resolvePin(
  registry: ModelRegistry | undefined,
  callerModel: Model<Api> | string | undefined,
  configModel: string | undefined,
): { pinned: Model<Api> | undefined; modelInput: string | undefined } {
  if (callerModel != null) {
    const modelInput = typeof callerModel === "string" ? callerModel : `${callerModel.provider}/${callerModel.id}`;
    if (!registry) throw new RpcError("model_registry_unavailable", `Model override "${modelInput}" provided but ctx.modelRegistry is unavailable`);
    if (typeof callerModel !== "string") return { pinned: callerModel, modelInput };
    const resolved = resolveModel(callerModel, registry);
    if (typeof resolved === "string") throw new RpcError("model_not_found", resolved);
    return { pinned: resolved, modelInput };
  }
  if (!configModel || !registry) return { pinned: undefined, modelInput: configModel };
  const resolved = resolveModel(configModel, registry);
  return { pinned: typeof resolved === "string" ? undefined : resolved, modelInput: configModel };
}

export function createSpawnFunnel(deps: SpawnFunnelDeps): SpawnFunnel {
  const { manager, reloadCustomAgents } = deps;

  const capabilityFor = (ctxRef: ExtensionContext, type: string, options: FunnelOptions, config?: AgentConfig, raw?: Partial<AgentConfig>, ephemeral?: boolean) =>
    resolveCapability({
      type,
      cwd: ctxRef?.cwd ?? process.cwd(),
      config: config && { ...config, extensions: config.extensions ?? true, skills: config.skills ?? true },
      raw,
      ephemeral,
      isolated: options?.isolated,
      notify: (message, level) => ctxRef?.ui?.notify?.(message, level),
    });

  const scopedOptions = (ctxRef: ExtensionContext, label: string, options: FunnelOptions, configModel: string | undefined): ScopedOptions => {
    const registry = ctxRef?.modelRegistry;
    const callerModel = options?.model;
    const { pinned, modelInput } = resolvePin(registry, callerModel, configModel);
    if (pinned == null || !registry) return { ...options, model: undefined };
    const scoped = scopeModel({
      pinned,
      sessionModel: ctxRef.model,
      cwd: ctxRef.cwd ?? process.cwd(),
      modelRegistry: registry,
      callerSupplied: callerModel != null,
      agentLabel: label,
      modelInput,
    });
    if (!scoped.ok) throw new RpcError("model_out_of_scope", scoped.message);
    if (scoped.replaced === undefined) return { ...options, model: pinned };
    if (scoped.notice) ctxRef.ui?.notify?.(scoped.notice, "warning");
    return { ...options, model: scoped.model, modelReplaced: scoped.replaced };
  };

  const spawnResolved: FunnelSpawn = (piRef, ctxRef, type, prompt, rawOptions, rawAgentConfig) => {
    const inline: AgentConfig | undefined = rawOptions?.agentConfig;
    if (inline) {
      const options = scopedOptions(ctxRef, inline.displayName ?? type, rawOptions, inline.model);
      return manager.spawn(piRef, ctxRef, type, prompt, {
        ...options,
        description: options.description ?? type,
        capability: capabilityFor(ctxRef, type, options, inline, rawAgentConfig ?? (options.ephemeral ? undefined : inline), Boolean(options.ephemeral)),
        isolation: resolveIsolation(inline.isolation, options?.isolation, isWorktreeIsolationEnabled()),
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns, inline),
      });
    }
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new RpcError("unknown_type", dispatch.message);
    const config = getAgentConfig(dispatch.type);
    const options = scopedOptions(ctxRef, config?.displayName ?? dispatch.type, rawOptions, config?.model);
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, {
      ...options,
      description: options.description ?? dispatch.type,
      capability: capabilityFor(ctxRef, dispatch.type, options),
      isolation: resolveIsolation(getAgentConfig(dispatch.type)?.isolation, options?.isolation, isWorktreeIsolationEnabled()),
      maxTurns: options?.maxTurns ?? resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns),
    });
  };

  const spawnTopLevel: FunnelSpawn = (piRef, ctxRef, type, prompt, options, rawAgentConfig) => {
    const { signalCause: _ignored, ...rest } = options ?? {};
    const safeOptions: FunnelOptions = rest.signal ? { ...rest, signalCause: "extension" } : rest;
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
