import type { AgentRecord } from "./types.js";
import { getLifetimeTotal, toReportedUsage } from "./usage.js";

export function buildEventData(record: AgentRecord) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0
    ? { input: u.input, output: u.output, total }
    : undefined;
  const usage = toReportedUsage(u);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
    usage,
  };
}
