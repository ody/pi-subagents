import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, resolveSpawnType } from "../agents/agent-types.js";
import {
  type BuiltEphemeralAgent,
  buildEphemeralAgent,
  type EphemeralParams,
  ephemeralIsolationConflict,
  namedAgentParamConflict,
} from "../agents/ephemeral-agent.js";
import { type GrantedCapability, resolveCapability } from "../config/capability-policy.js";
import { describeModel, resolveModel } from "../config/model-resolver.js";
import { scopeModel } from "../config/model-scope.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../config/runner-defaults.js";
import { getOutputTranscriptDefault } from "../platform/output-file.js";
import type { AgentConfig, AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "../types.js";
import { buildInvocationTags, getDisplayName, getPromptModeLabel } from "../ui/agent-format.js";
import { describeOverrides, resolveAgentInvocationConfig } from "./invocation-config.js";

export interface DetailBase {
  displayName: string;
  description: string;
  subagentType: SubagentType;
  modelName: string | undefined;
  tags: string[] | undefined;
}

export type AgentCallParams = Parameters<typeof resolveAgentInvocationConfig>[1] & Partial<Omit<EphemeralParams, "description" | "isolated">> & {
  subagent_type?: string;
  name?: string;
  description: string;
  resume?: string;
};

export type AgentCallResolution =
  | { ok: false; message: string }
  | {
      ok: true;
      subagentType: SubagentType;
      displayName: string;
      model: any;
      modelReplaced: string | undefined;
      thinking: ThinkingLevel | undefined;
      inheritContext: boolean;
      runInBackground: boolean;
      isolated: boolean;
      isolation: IsolationMode | undefined;
      outputTranscript: boolean;
      capability: GrantedCapability | undefined;
      agentConfig: AgentConfig | undefined;
      ephemeral: { handleSeed: string } | undefined;
      effectiveMaxTurns: number | undefined;
      agentInvocation: AgentInvocation;
      detailBase: DetailBase;
    };

export function detailBaseFor(detailBase: DetailBase, rec: AgentRecord | undefined): DetailBase {
  if (!rec?.invocation) return detailBase;
  const type = rec.type;
  const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
  const recModeLabel = getPromptModeLabel(rec);
  const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
  return {
    displayName: getDisplayName(rec),
    description: rec.description,
    subagentType: type,
    modelName: recModelName,
    tags: recTags.length > 0 ? recTags : undefined,
  };
}

function mintCapability(
  params: AgentCallParams,
  ctx: Pick<ExtensionContext, "cwd"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
  type: SubagentType,
  isolated: boolean,
  built: BuiltEphemeralAgent | undefined,
): { ok: true; capability: GrantedCapability | undefined } | { ok: false; message: string } {
  if (params.resume) return { ok: true, capability: undefined };
  try {
    const capability = resolveCapability({
      type,
      cwd: ctx.cwd,
      config: built?.config,
      raw: built?.supplied,
      explicitTools: built?.explicitTools,
      ephemeral: built !== undefined,
      isolated,
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    return { ok: true, capability };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function omitsType(params: AgentCallParams): boolean {
  return !params.resume && (params.subagent_type ?? "").trim() === "";
}

function typeParamConflict(params: AgentCallParams): string | undefined {
  if (omitsType(params)) {
    return ephemeralIsolationConflict({ ...params, description: params.description });
  }
  if (params.resume) return undefined;
  return namedAgentParamConflict(params);
}

function dispatchType(
  params: AgentCallParams,
  built: BuiltEphemeralAgent | undefined,
): { ok: false; message: string } | { ok: true; subagentType: SubagentType } {
  const rawType = (params.subagent_type ?? "") as SubagentType;
  const dispatch = built ? { ok: true as const, type: built.type } : resolveSpawnType(rawType);
  if (!dispatch.ok && !params.resume) {
    return { ok: false, message: `${dispatch.message} Omit subagent_type to run a one-off agent built from the call's parameters.` };
  }
  return { ok: true, subagentType: dispatch.ok ? dispatch.type : rawType };
}

function resolveCallModel(
  params: AgentCallParams,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
  invocation: Pick<ReturnType<typeof resolveAgentInvocationConfig>, "modelInput" | "modelFromParams">,
  agentLabel: string,
): { ok: false; message: string } | { ok: true; model: Model<any> | undefined; replaced: string | undefined } {
  let pinned: Model<any> | undefined;
  if (invocation.modelInput) {
    const resolved = resolveModel(invocation.modelInput, ctx.modelRegistry);
    if (typeof resolved === "string") {
      if (invocation.modelFromParams) return { ok: false, message: resolved };
    } else {
      pinned = resolved;
    }
  }
  if (params.resume) return { ok: true, model: pinned ?? ctx.model, replaced: undefined };
  const scoped = scopeModel({
    pinned,
    sessionModel: ctx.model,
    cwd: ctx.cwd,
    modelRegistry: ctx.modelRegistry,
    callerSupplied: invocation.modelFromParams,
    agentLabel,
    modelInput: invocation.modelInput,
  });
  if (!scoped.ok) return { ok: false, message: scoped.message };
  if (scoped.notice) ctx.ui.notify(scoped.notice, "warning");
  return { ok: true, model: scoped.model, replaced: scoped.replaced };
}

export function resolveAgentCall(
  params: AgentCallParams,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
  opts: { worktreeAllowed: boolean; defaultRunInBackground: boolean; forceBackground?: boolean },
): AgentCallResolution {
  const conflict = typeParamConflict(params);
  if (conflict) return { ok: false, message: conflict };
  const built = omitsType(params) ? buildEphemeralAgent({ ...params, description: params.description }) : undefined;
  const dispatched = dispatchType(params, built);
  if (!dispatched.ok) return dispatched;
  const { subagentType } = dispatched;

  const displayName = getDisplayName({ type: subagentType, displayName: built?.config.displayName });

  const customConfig = built ? undefined : getAgentConfig(subagentType);

  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
    worktreeAllowed: opts.worktreeAllowed,
    defaultRunInBackground: opts.defaultRunInBackground,
    forceBackground: opts.forceBackground,
  });

  const resolvedModel = resolveCallModel(params, ctx, resolvedConfig, customConfig?.displayName ?? subagentType);
  if (!resolvedModel.ok) return resolvedModel;
  const { model, replaced: modelReplaced } = resolvedModel;

  const minted = mintCapability(params, ctx, subagentType, resolvedConfig.isolated, built);
  if (!minted.ok) return minted;
  const capability = minted.capability;

  const thinking = resolvedConfig.thinking;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;
  const isolated = resolvedConfig.isolated;
  const isolation = resolvedConfig.isolation;
  const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();

  const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
  const effectiveMaxTurns = resolvedConfig.maxTurns ?? getDefaultMaxTurns();
  const agentInvocation: AgentInvocation = {
    modelName,
    modelId,
    thinking,
    ...describeOverrides(resolvedConfig.overridden, model, ctx.modelRegistry),
    maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
    isolated,
    inheritContext,
    runInBackground,
    isolation,
  };
  const modeLabel = getPromptModeLabel({ type: subagentType, promptMode: built?.config.promptMode });
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
  const detailBase = {
    displayName,
    description: params.description,
    subagentType,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
  };

  return {
    ok: true,
    subagentType,
    displayName,
    model,
    modelReplaced,
    thinking,
    inheritContext,
    runInBackground,
    isolated,
    isolation,
    outputTranscript,
    capability,
    agentConfig: built?.config,
    ephemeral: built ? { handleSeed: params.name ?? params.description } : undefined,
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  };
}
