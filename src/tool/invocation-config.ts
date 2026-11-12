import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveModel } from "../config/model-resolver.js";
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

interface ResolveOptions {
  worktreeAllowed?: boolean;
  defaultRunInBackground?: boolean;
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
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  const displaced = <T,>(fileValue: T | undefined, callerValue: T | undefined): T | undefined =>
    fileValue != null && callerValue != null && fileValue !== callerValue ? fileValue : undefined;
  const overriddenThinking = displaced(agentConfig?.thinking as ThinkingLevel | undefined, params.thinking as ThinkingLevel | undefined);
  const overriddenModel = displaced(agentConfig?.model, params.model);
  const overriddenMaxTurns = displaced(agentConfig?.maxTurns, params.max_turns);
  const overriddenRunInBackground = displaced(agentConfig?.runInBackground, params.run_in_background);
  const hasOverride = overriddenThinking !== undefined || overriddenModel !== undefined
    || overriddenMaxTurns !== undefined || overriddenRunInBackground !== undefined;

  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
    maxTurns: params.max_turns ?? agentConfig?.maxTurns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: params.run_in_background ?? agentConfig?.runInBackground ?? opts?.defaultRunInBackground ?? false,
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
  model: Model<any> | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
): Pick<AgentInvocation, "pinnedModel" | "pinnedThinking" | "pinnedMaxTurns" | "pinnedRunInBackground"> {
  const pin = overridden?.model;
  const resolvedPin = pin === undefined ? undefined : resolveModel(pin, modelRegistry);
  const samePin = resolvedPin !== undefined && typeof resolvedPin !== "string"
    && resolvedPin.provider === model?.provider && resolvedPin.id === model?.id;
  return {
    pinnedModel: pin === undefined || samePin ? undefined : pin,
    pinnedThinking: overridden?.thinking,
    pinnedMaxTurns: overridden?.maxTurns,
    pinnedRunInBackground: overridden?.runInBackground,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
