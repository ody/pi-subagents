import { describe, expect, it } from "vitest";
import { addUsage, assistantUsage, getLifetimeCost, getLifetimeTotal, getSessionContextPercent, getSessionTokens, PendingUsagePool } from "../src/usage.js";

describe("usage", () => {
  describe("getSessionTokens", () => {
    it("uses billed-token semantics (input + output + cacheWrite), not inflated total", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("returns 0 when session is undefined or stats throw", () => {
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });
  });

  describe("getSessionContextPercent", () => {
    it("returns null when contextUsage is unavailable", () => {
      const session = {
        getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns null when percent is null (post-compaction)", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
        }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });
  });

  describe("getLifetimeTotal", () => {
    it("sums components and handles undefined", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
    });

    it("agrees with getSessionTokens pre-compaction, diverges after", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };
      const lifetime = { input: 100, output: 200, cacheWrite: 50 };

      expect(getSessionTokens(session)).toBe(350);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      sessionStatsTokens = { input: 0, output: 0, cacheWrite: 0 };

      expect(getSessionTokens(session)).toBe(0);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      sessionStatsTokens = { input: 80, output: 150, cacheWrite: 30 };
      lifetime.input += 80; lifetime.output += 150; lifetime.cacheWrite += 30;

      expect(getSessionTokens(session)).toBe(260);
      expect(getLifetimeTotal(lifetime)).toBe(610);
    });

    it("stays monotone across simulated compaction when fed via addUsage-style accumulation", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      const beforeCompaction = getLifetimeTotal(usage);

      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction);

      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });

  describe("cost accumulation", () => {
    it("sums cost across messages but keeps it out of the token total", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.002 });
      addUsage(usage, { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.004 });

      expect(getLifetimeCost(usage)).toBeCloseTo(0.006, 10);
      expect(getLifetimeTotal(usage)).toBe(460);
      expect(usage.cacheRead).toBe(2700);
    });

    it("leaves cost absent when nothing priced anything", () => {
      const usage: { input: number; output: number; cacheWrite: number; cost?: number } =
        { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 10, output: 5, cacheWrite: 0, cost: 0 });

      expect(usage.cost).toBeUndefined();
      expect(getLifetimeCost(usage)).toBe(0);
    });

    it("reads a missing cost as 0", () => {
      expect(getLifetimeCost(undefined)).toBe(0);
      expect(getLifetimeCost({ input: 1, output: 1, cacheWrite: 0 })).toBe(0);
    });
  });

  describe("PendingUsagePool", () => {
    it("drains what it accumulated as a complete pi Usage", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.01 });
      pool.add({ input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.02 });

      expect(pool.drain()).toEqual({
        input: 300,
        output: 130,
        cacheRead: 2700,
        cacheWrite: 30,
        totalTokens: 3160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
    });

    it("empties on drain, so no message is reported twice", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });

      expect(pool.drain()?.totalTokens).toBe(160);
      expect(pool.drain()).toBeUndefined();
    });

    it("handles an accumulator that never saw a cacheRead or a cost", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10 });

      expect(pool.drain()).toEqual({
        input: 100, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    });

    it("returns undefined when nothing has been added", () => {
      expect(new PendingUsagePool().drain()).toBeUndefined();
    });

    it("still reports tokens spent by a model with no pricing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

      const drained = pool.drain();
      expect(drained?.totalTokens).toBe(160);
      expect(drained?.cost.total).toBe(0);
    });

    it("reports nothing for a message that spent nothing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 0, output: 0, cacheWrite: 0, cost: 0 });

      expect(pool.drain()).toBeUndefined();
    });
  });
});

describe("assistantUsage", () => {
  it("returns undefined when the message has no usage", () => {
    expect(assistantUsage({})).toBeUndefined();
  });

  it("maps all fields, taking cost from cost.total", () => {
    expect(
      assistantUsage({ usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: { total: 0.5 } } }),
    ).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: 0.5 });
  });

  it("defaults missing fields to 0", () => {
    expect(assistantUsage({ usage: {} })).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
  });
});
