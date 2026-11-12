import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, resolveSpawnType, resolveType } from "../agents/agent-types.js";
import { type GrantedCapability, resolveCapability } from "../config/capability-policy.js";
import { describeModel, resolveModel } from "../config/model-resolver.js";
import { checkModelScope } from "../config/model-scope.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../config/runner-defaults.js";
import { getOutputTranscriptDefault } from "../platform/output-file.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "../types.js";
import { buildInvocationTags, getDisplayName, getPromptModeLabel } from "../ui/agent-format.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";

export interface DetailBase {
  displayName: string;
  description: string;
  subagentType: SubagentType;
  modelName: string | undefined;
  tags: string[] | undefined;
}

export type AgentCallParams = Parameters<typeof resolveAgentInvocationConfig>[1] & {
  subagent_type: string;
  description: string;
  resume?: string;
  schedule?: unknown;
};

export type AgentCallResolution =
  | { ok: false; message: string }
  | {
      ok: true;
      subagentType: SubagentType;
      requestedType: string;
      fallbackNote: string;
      displayName: string;
      model: any;
      thinking: ThinkingLevel | undefined;
      inheritContext: boolean;
      runInBackground: boolean;
      isolated: boolean;
      isolation: IsolationMode | undefined;
      outputTranscript: boolean;
      capability: GrantedCapability | undefined;
      effectiveMaxTurns: number | undefined;
      agentInvocation: AgentInvocation;
      detailBase: DetailBase;
    };

export function detailBaseFor(detailBase: DetailBase, rec: AgentRecord | undefined): DetailBase {
  if (!rec?.invocation) return detailBase;
  const type = rec.type;
  const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
  const recModeLabel = getPromptModeLabel(type);
  const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
  return {
    displayName: getDisplayName(type),
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
): { ok: true; capability: GrantedCapability | undefined } | { ok: false; message: string } {
  if (params.resume || params.schedule) return { ok: true, capability: undefined };
  try {
    const capability = resolveCapability({
      type,
      cwd: ctx.cwd,
      isolated,
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    return { ok: true, capability };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function resolveAgentCall(
  params: AgentCallParams,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
  opts: { worktreeAllowed: boolean; defaultRunInBackground: boolean },
): AgentCallResolution {
  const rawType = params.subagent_type as SubagentType;
  const dispatch = resolveSpawnType(rawType);
  if (!dispatch.ok && !params.resume) return { ok: false, message: dispatch.message };
  const subagentType = dispatch.ok ? dispatch.type : rawType;
  const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
  const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
    ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
    : "";

  const displayName = getDisplayName(subagentType);

  const customConfig = getAgentConfig(subagentType);

  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
    worktreeAllowed: opts.worktreeAllowed,
    defaultRunInBackground: opts.defaultRunInBackground,
  });

  let model = ctx.model;
  if (resolvedConfig.modelInput) {
    const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
    if (typeof resolved === "string") {
      if (resolvedConfig.modelFromParams) return { ok: false, message: resolved };
    } else {
      model = resolved;
    }
  }

  const scopeVerdict = checkModelScope({
    model,
    cwd: ctx.cwd,
    modelRegistry: ctx.modelRegistry,
    callerSupplied: resolvedConfig.modelFromParams,
    agentLabel: customConfig?.displayName ?? subagentType,
    modelInput: resolvedConfig.modelInput,
  });
  if (scopeVerdict.kind === "error") return { ok: false, message: scopeVerdict.message };
  if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

  const minted = mintCapability(params, ctx, subagentType, resolvedConfig.isolated);
  if (!minted.ok) return minted;
  const capability = minted.capability;

  const thinking = resolvedConfig.thinking;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;
  const isolated = resolvedConfig.isolated;
  const isolation = resolvedConfig.isolation;
  const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();

  const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
  const pinnedModel = ((pin: string | undefined) => {
    if (!pin) return undefined;
    const resolvedPin = resolveModel(pin, ctx.modelRegistry);
    if (typeof resolvedPin === "string") return pin;
    return resolvedPin.provider === model?.provider && resolvedPin.id === model?.id ? undefined : pin;
  })(resolvedConfig.overridden?.model);
  const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
  const agentInvocation: AgentInvocation = {
    modelName,
    modelId,
    thinking,
    requestedThinking: resolvedConfig.overridden?.thinking,
    pinnedModel,
    maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
    isolated,
    inheritContext,
    runInBackground,
    isolation,
  };
  const modeLabel = getPromptModeLabel(subagentType);
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
    requestedType,
    fallbackNote,
    displayName,
    model,
    thinking,
    inheritContext,
    runInBackground,
    isolated,
    isolation,
    outputTranscript,
    capability,
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  };
}
