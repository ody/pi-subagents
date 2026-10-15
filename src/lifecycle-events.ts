// `subagents:*` lifecycle event payload shape.

import type { AgentRecord } from "./types.js";
import { getLifetimeTotal, toReportedUsage } from "./usage.js";

/** Build event data for lifecycle events from an AgentRecord. */
export function buildEventData(record: AgentRecord) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  // All three fields are lifetime-accumulated (Σ over every assistant message_end),
  // so they survive compaction together — input + output ≤ total always.
  // tokens is omitted when nothing was ever produced (e.g. agent errored before
  // any message_end fired), preserving prior payload shape.
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0
    ? { input: u.input, output: u.output, total }
    : undefined;
  // The whole run's spend as a pi `Usage` — pi's convention for handing spend
  // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
  // listener already expects them and anything pi adds to `Usage` arrives
  // without a change here. Omitted when nothing was spent, so "spent nothing"
  // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
  // governs what a human is shown, not what the event carries.
  //
  // `tokens` above is the other convention, kept as it shipped: a flat view
  // model like pi's own `SessionStats`, carrying the DISPLAY total, which
  // excludes cacheRead (#38). The two answer different questions and neither
  // derives from the other.
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
