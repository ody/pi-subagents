import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { type ModelResolutionEnv, resolvePinnedModel } from "../config/model-scope.js";
import type { AgentConfig, AgentInvocation, IsolationMode, JoinMode, ThinkingLevel } from "../types.js";

const isolationParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
};

export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: unknown;
}

export function resolveIsolation(fileValue: unknown, callerValue: unknown, worktreeAllowed: boolean): IsolationMode | undefined {
  const requested = fileValue ?? callerValue;
  return requested === "worktree" && worktreeAllowed ? "worktree" : undefined;
}

export const FORCED_BACKGROUND = Symbol("pi-subagents:forced-background");

interface ResolveOptions {
  worktreeAllowed?: boolean;
  defaultRunInBackground?: boolean;
  forceBackground?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  overridden?: { thinking?: ThinkingLevel; model?: string; maxTurns?: number; runInBackground?: boolean };
} {
  const isolation = resolveIsolation(agentConfig?.isolation, params.isolation, opts?.worktreeAllowed !== false);
  const presentModel = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const callerModel = presentModel(params.model);
  const configModel = presentModel(agentConfig?.model);

  const displaced = <T,>(fileValue: T | undefined, callerValue: T | undefined): T | undefined =>
    fileValue != null && callerValue != null && fileValue !== callerValue ? fileValue : undefined;
  const overriddenThinking = displaced(agentConfig?.thinking as ThinkingLevel | undefined, params.thinking as ThinkingLevel | undefined);
  const overriddenModel = displaced(configModel, callerModel);
  const overriddenMaxTurns = displaced(agentConfig?.maxTurns, params.max_turns);
  const overriddenRunInBackground = opts?.forceBackground
    ? undefined
    : displaced(agentConfig?.runInBackground, params.run_in_background);
  const hasOverride = overriddenThinking !== undefined || overriddenModel !== undefined
    || overriddenMaxTurns !== undefined || overriddenRunInBackground !== undefined;

  return {
    modelInput: callerModel ?? configModel,
    modelFromParams: callerModel !== undefined,
    thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
    maxTurns: params.max_turns ?? agentConfig?.maxTurns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: opts?.forceBackground || (params.run_in_background ?? agentConfig?.runInBackground ?? opts?.defaultRunInBackground ?? false),
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
    overridden: hasOverride
      ? {
        thinking: overriddenThinking,
        model: overriddenModel,
        maxTurns: overriddenMaxTurns,
        runInBackground: overriddenRunInBackground,
      }
      : undefined,
  };
}

export function describeOverrides(
  overridden: ReturnType<typeof resolveAgentInvocationConfig>["overridden"],
  model: Model<Api> | undefined,
  env: ModelResolutionEnv,
): Pick<AgentInvocation, "pinnedModel" | "pinnedThinking" | "pinnedMaxTurns" | "pinnedRunInBackground"> {
  const pin = overridden?.model;
  const resolved = pin === undefined ? undefined : resolvePinnedModel({ modelInput: pin, modelFromParams: false }, env);
  const resolvedPin = resolved?.ok ? resolved.pinned : undefined;
  const samePin = resolvedPin !== undefined
    && resolvedPin.provider === model?.provider && resolvedPin.id === model?.id;
  const pinLabel = resolvedPin === undefined ? pin : `${resolvedPin.provider}/${resolvedPin.id}`;
  return {
    pinnedModel: pin === undefined || samePin ? undefined : pinLabel,
    pinnedThinking: overridden?.thinking,
    pinnedMaxTurns: overridden?.maxTurns,
    pinnedRunInBackground: overridden?.runInBackground,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
