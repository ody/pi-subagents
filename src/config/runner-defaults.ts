import { getAgentConfig } from "../agents/agent-types.js";
import type { AgentConfig } from "../types.js";

let defaultMaxTurns: number | undefined;

export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

export function resolveEffectiveMaxTurns(
  type: string,
  explicit?: number,
  agentConfig: AgentConfig | undefined = getAgentConfig(type),
): number | undefined {
  return normalizeMaxTurns(explicit ?? agentConfig?.maxTurns ?? defaultMaxTurns);
}

let rememberAgents = true;

export function getRememberAgents(): boolean { return rememberAgents; }
export function setRememberAgents(b: boolean): void { rememberAgents = b; }

let graceTurns = 5;

export function getGraceTurns(): number { return graceTurns; }
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

export function turnLimitAction(
  turnCount: number,
  maxTurns: number | undefined,
  softLimitReached: boolean,
  graceTurns: number,
): "steer" | "abort" | undefined {
  if (maxTurns == null) return undefined;
  if (!softLimitReached && turnCount >= maxTurns) return "steer";
  if (softLimitReached && turnCount >= maxTurns + graceTurns) return "abort";
  return undefined;
}
