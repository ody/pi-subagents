// Shape of a tool result text and the `AgentDetails` block attached to it.

import type { AgentActivity } from "./types.js";
import { type AgentDetails, formatTokens } from "./ui/agent-widget.js";
import { getLifetimeCost, getLifetimeTotal, type LifetimeUsage } from "./usage.js";

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}
