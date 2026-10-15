/**
 * runner-defaults.ts — Process-wide run defaults set from settings: turn limits,
 * grace turns and session persistence.
 */

import { getAgentConfig } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/**
 * The turn limit a run of `type` will actually enforce: an explicit value if the
 * caller supplied one, else the agent's own `max_turns`, else the project
 * default. `undefined` = unlimited.
 *
 * Exported because the widget's turn counter (`↻3≤20`) has to predict this
 * before the run starts, and a second copy of the expression would drift from
 * the one runAgent uses to enforce it. `agentConfig` defaults to the registry
 * entry for `type`; an inline-config spawn passes its own.
 */
export function resolveEffectiveMaxTurns(
  type: string,
  explicit?: number,
  agentConfig: AgentConfig | undefined = getAgentConfig(type),
): number | undefined {
  return normalizeMaxTurns(explicit ?? agentConfig?.maxTurns ?? defaultMaxTurns);
}

/**
 * Project default for `persist_session`, from the `rememberAgents` setting.
 * On by default: a persisted session is what lets `@handle` reopen an agent's
 * conversation after its record has been evicted, which is the whole point of
 * addressing an agent by a name that outlives one run. Per-agent frontmatter
 * still overrides it in both directions.
 */
let rememberAgents = true;

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean { return rememberAgents; }
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(b: boolean): void { rememberAgents = b; }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }
