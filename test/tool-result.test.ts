import { describe, expect, it } from "vitest";
import { buildDetails, formatLifetimeTokens } from "../src/tool-result.js";
import type { AgentActivity } from "../src/types.js";

const base = {
  displayName: "Explorer",
  description: "finds things",
  subagentType: "explore",
  modelName: "haiku 4.5",
  tags: ["thinking: high"],
};

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { activeTools: new Map(), toolUses: 3, responseText: "", turnCount: 2, ...over };
}

const record = {
  toolUses: 3,
  startedAt: 1_000,
  completedAt: 4_000,
  status: "completed",
  id: "a1",
  lifetimeUsage: { input: 1_000, output: 500, cacheWrite: 0, cacheRead: 200, cost: 0.0123 },
};

describe("formatLifetimeTokens", () => {
  it("returns \"\" when no tokens were produced", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } })).toBe("");
  });

  it("returns \"\" when only money was spent — cost is not tokens", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 5 } })).toBe("");
  });

  it("formats the display total, excluding cacheRead", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 1_000, output: 500, cacheWrite: 0, cacheRead: 9_000 } })).toBe("1.5k token");
  });
});

describe("buildDetails", () => {
  it("maps base and record fields, with cost raw and tokens formatted", () => {
    const d = buildDetails(base, record);
    expect(d).toMatchObject({
      displayName: "Explorer",
      description: "finds things",
      subagentType: "explore",
      modelName: "haiku 4.5",
      tags: ["thinking: high"],
      toolUses: 3,
      // Preformatted display string: input + output + cacheWrite = 1500.
      tokens: "1.5k token",
      // Raw number, so each renderer can punctuate the cost its own way.
      cost: 0.0123,
      durationMs: 3_000,
      status: "completed",
      agentId: "a1",
    });
    expect(d.error).toBeUndefined();
  });

  it("carries turn state from activity", () => {
    const d = buildDetails(base, record, activity({ turnCount: 4, maxTurns: 7 }));
    expect(d.turnCount).toBe(4);
    expect(d.maxTurns).toBe(7);
  });

  it("leaves turn state undefined without activity", () => {
    const d = buildDetails(base, record);
    expect(d.turnCount).toBeUndefined();
    expect(d.maxTurns).toBeUndefined();
  });

  it("lets overrides win over computed fields", () => {
    const d = buildDetails(base, record, undefined, { tokens: "custom", status: "error", error: "boom" });
    expect(d.tokens).toBe("custom");
    expect(d.status).toBe("error");
    expect(d.error).toBe("boom");
  });
});
