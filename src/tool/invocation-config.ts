import { Type } from "@sinclair/typebox";
import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "../types.js";

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
  overridden?: { thinking?: ThinkingLevel; model?: string };
} {
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  const overriddenThinking = agentConfig?.thinking != null && params.thinking != null
    && agentConfig.thinking !== params.thinking
    ? params.thinking as ThinkingLevel
    : undefined;
  const overriddenModel = agentConfig?.model != null && params.model != null
    && agentConfig.model !== params.model
    ? agentConfig.model
    : undefined;

  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
    overridden: overriddenThinking || overriddenModel
      ? { thinking: overriddenThinking, model: overriddenModel }
      : undefined,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
