import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, resolveSpawnType, resolveType } from "./agent-types.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { describeModel, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { getOutputTranscriptDefault } from "./output-file.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "./runner-defaults.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { buildInvocationTags, getDisplayName, getPromptModeLabel } from "./ui/agent-widget.js";

/** The fields every Agent result's `details` start from. */
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
      effectiveMaxTurns: number | undefined;
      agentInvocation: AgentInvocation;
      detailBase: DetailBase;
    };

/**
 * `detailBase` for a record that exists, which outranks it: the base is a
 * snapshot of what this call REQUESTED, and pi may have resolved a
 * different model or clamped the thinking level (agent-manager writes the
 * effective values back when the session reports them). Resume goes
 * further and ignores the model/thinking parameters outright — it runs on
 * the session it is reopening — so rendering the base there advertises
 * settings the run never used.
 *
 * The mode label is rebuilt rather than carried over: it hangs off the
 * agent TYPE, not the invocation, so tags taken straight from
 * buildInvocationTags would silently drop `twin`.
 */
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

/**
 * Turn the Agent tool's parameters into a resolved invocation: dispatch, model,
 * scope check, invocation config and the `details` base. An `ok: false` result
 * carries the text the tool returns to the model. May notify through `ctx.ui`
 * when the scope check only warns.
 */
export function resolveAgentCall(
  params: AgentCallParams,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd"> & { ui: Pick<ExtensionContext["ui"], "notify"> },
  opts: { worktreeAllowed: boolean; defaultRunInBackground: boolean },
): AgentCallResolution {
  const rawType = params.subagent_type as SubagentType;
  // Single decision point for dispatch (#183): unknown, disabled and
  // case-ambiguous types are refused here, BEFORE anything spawns, so a
  // background or scheduled call can't start running the wrong agent while
  // the caller is still unaware. `fallbackSubagent` decides whether an
  // unresolvable type falls back or fails closed.
  const dispatch = resolveSpawnType(rawType);
  // `resume` replays a stored session and ignores `subagent_type` entirely,
  // but the parameter is required by the schema — so gating it here would
  // make a live agent unresumable the moment its type is deleted, disabled,
  // or gains a case-clashing sibling. Only a real spawn is gated.
  if (!dispatch.ok && !params.resume) return { ok: false, message: dispatch.message };
  const subagentType = dispatch.ok ? dispatch.type : rawType;
  // What the caller actually asked for, named once: `fellBackFrom` is "" for
  // a blank request, so reading it inline invites the `??`-vs-`||` slip that
  // once persisted an empty type into a scheduled job.
  const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
  // Computed at resolution rather than after the run, so the background and
  // schedule branches carry it too — previously it existed only on the
  // foreground path. Resume deliberately doesn't: it replays the stored
  // session and ignores `subagent_type` entirely, so a note about type
  // substitution would be describing something that didn't happen.
  const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
    ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
    : "";

  const displayName = getDisplayName(subagentType);

  // Get agent config (if any)
  const customConfig = getAgentConfig(subagentType);

  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
    worktreeAllowed: opts.worktreeAllowed,
    defaultRunInBackground: opts.defaultRunInBackground,
  });

  // Caller-supplied model first; the agent file's pin is the fallback. An
  // unresolvable caller spelling is a hard error rather than a quiet demotion
  // to the pin — same policy as an out-of-scope caller model.
  let model = ctx.model;
  if (resolvedConfig.modelInput) {
    const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
    if (typeof resolved === "string") {
      if (resolvedConfig.modelFromParams) return { ok: false, message: resolved };
      // config-specified: silent fallback to parent
    } else {
      model = resolved;
    }
  }

  // Scope validation: the effective resolved model is checked against the
  // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
  // in model-scope.ts so the nested delegation tools apply the same rule.
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

  const thinking = resolvedConfig.thinking;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;
  const isolated = resolvedConfig.isolated;
  const isolation = resolvedConfig.isolation;
  // Whether this spawn writes its .output transcript. Per-agent
  // frontmatter (`output_transcript`) wins; otherwise the project/global
  // default applies.
  const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();

  // Unconditional, not "only when it differs from the parent": a thinking
  // level reads as a property of a model, and an agent that inherited the
  // parent's model used to show the level with nothing to attach it to.
  // This is the pre-session snapshot — agent-manager overwrites it with the
  // effective values the moment a session reports them.
  const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
  // The agent file's pin, kept only if it names a different model than the one
  // that won. Model input is fuzzy — `"haiku"` and
  // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
  // strings would disclose an override that never happened. A pin that
  // resolves to nothing is still worth disclosing: it cannot have taken effect.
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
    // Only set where the agent file outranked the caller, so the surfaces can
    // disclose a parameter that was accepted but could not take effect (#182).
    requestedThinking: resolvedConfig.overridden?.thinking,
    // The mirror image: `model` precedence runs the other way, so what gets
    // disclosed is the pin the caller displaced.
    pinnedModel,
    // Explicit value only — the default fallback would just add noise.
    // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
    maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
    isolated,
    inheritContext,
    runInBackground,
    isolation,
  };
  // Tool-result render shows the mode label too; viewer's header already does.
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
    effectiveMaxTurns,
    agentInvocation,
    detailBase,
  };
}
