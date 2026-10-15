import { describe, expect, it } from "vitest";
import { buildEventData } from "../src/lifecycle-events.js";
import type { AgentRecord } from "../src/types.js";

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "audit",
    status: "completed",
    toolUses: 2,
    startedAt: 1_000,
    completedAt: 4_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

describe("buildEventData", () => {
  it("omits tokens when nothing was produced", () => {
    // cacheRead-only spend: money moved, but the display total is zero.
    const data = buildEventData(rec({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 50, cost: 0.01 } }));
    expect(data.tokens).toBeUndefined();
    expect(data.usage?.totalTokens).toBe(50);
    expect(data.usage?.cost.total).toBe(0.01);
  });

  it("omits usage when nothing was spent", () => {
    const data = buildEventData(rec());
    expect(data.usage).toBeUndefined();
    expect(data.tokens).toBeUndefined();
  });

  it("reports tokens and usage when there was a real run", () => {
    const data = buildEventData(rec({
      result: "done",
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 20, cost: 0.25 },
    }));
    // tokens is the display view: excludes cacheRead.
    expect(data.tokens).toEqual({ input: 100, output: 50, total: 160 });
    // usage is a pi Usage: includes cacheRead and the whole spend.
    expect(data.usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { total: 0.25 },
    });
    expect(data.durationMs).toBe(3_000);
  });
});
