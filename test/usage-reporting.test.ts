import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { registerAgents } from "../src/agents/agent-types.js";
import subagentsExtension from "../src/index.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";
import { addUsage } from "../src/usage.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { grant } from "./helpers/capability.js";

function runSpending(usage: { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number }) {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
    opts.onAssistantUsage?.(usage);
    return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
  });
}

function runSpendingNothing() {
  vi.mocked(runAgent).mockImplementation(async () => (
    { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false }
  ));
}

const spawn = (tools: Map<string, any>, toolCallId: string | undefined) =>
  tools.get("Agent").execute(
    toolCallId,
    { prompt: "go", description: "spend", subagent_type: "general-purpose", run_in_background: false },
    undefined, undefined, ctx(),
  );

describe("reporting subagent usage back to the parent session", () => {
  let hermetic: Hermetic;

  function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    hermetic?.restore();
  });

  it("attaches a complete pi Usage to the tool result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

    const result = await spawn(tools, "tc-1");

    expect(result.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheWrite: 10,
      totalTokens: 1060,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    });
  });

  it("reports each message's spend exactly once", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    await spawn(tools, "tc-1");
    runSpendingNothing();
    const second = await spawn(tools, "tc-2");

    expect(second.usage).toBeUndefined();
  });

  it("carries what a later run spends on the later result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
    await spawn(tools, "tc-1");

    runSpending({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
    const second = await spawn(tools, "tc-2");

    expect(second.usage.totalTokens).toBe(10);
    expect(second.usage.cost.total).toBe(0.002);
  });

  it("attaches nothing when the setting is off", async () => {
    const { tools } = boot({ reportUsage: false });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const result = await spawn(tools, "tc-1");

    expect(result.usage).toBeUndefined();
    expect(result.content[0].text).toContain("Agent completed");
  });

  it("defaults to off", async () => {
    const { tools } = boot({});
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    expect((await spawn(tools, "tc-1")).usage).toBeUndefined();
  });

  it("attaches nothing to a call with no tool-call id, and loses none of it", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const cloned = await spawn(tools, undefined);
    expect(cloned.usage).toBeUndefined();

    runSpendingNothing();
    const real = await spawn(tools, "tc-2");
    expect(real.usage.cost.total).toBe(0.0123);
    expect(real.usage.totalTokens).toBe(160);
  });

  it("attaches nothing when a run produced no usage at all", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpendingNothing();

    expect((await spawn(tools, "tc-1")).usage).toBeUndefined();
  });

  it("reports an unpriced model's tokens with a zero cost rather than dropping them", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

    const result = await spawn(tools, "tc-1");

    expect(result.usage.totalTokens).toBe(160);
    expect(result.usage.cost.total).toBe(0);
  });

  it("reports what a background resume spends, on the next call", async () => {
    const { pi, tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    await spawn(tools, "tc-1");
    await flush();
    const id = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed")?.[1]?.id;

    vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      return { text: "resumed" };
    });

    const started = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "more", description: "spend", subagent_type: "general-purpose", resume: id, run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();
    runSpendingNothing();
    const next = await spawn(tools, "tc-3");

    const reported = [started.usage, next.usage].filter(Boolean);
    expect(reported).toHaveLength(1);
    expect(reported[0].cost.total).toBe(0.002);
    expect(reported[0].totalTokens).toBe(10);
  });

  it("counts a nested child's spend once, on the top-level agent's report", async () => {
    const { pi, tools } = boot({ reportUsage: true });
    let nested = false;

    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
      if (!nested) {
        nested = true;
        const { manager, parentAgentId } = opts.nestedRuntime;
        const childId = manager.spawn(pi, ctx(), "general-purpose", "sub", {
          capability: grant(),
          description: "nested",
          isBackground: false,
          parentAgentId,
          onAssistantUsage: (u: any) => addUsage(manager.getRecord(parentAgentId).lifetimeUsage, u),
        });
        await manager.getRecord(childId).promise;
      }
      return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
    });

    const result = await spawn(tools, "tc-1");

    expect(nested).toBe(true);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.usage.cost.total).toBeCloseTo(0.02, 10);
  });

  it("reports what a resume spends, not only the first run", async () => {
    const { pi, tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    await spawn(tools, "tc-1");
    await flush();

    vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      return { text: "resumed" };
    });

    const id = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed")?.[1]?.id;
    const result = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "more", description: "spend", subagent_type: "general-purpose", resume: id, run_in_background: false },
      undefined, undefined, ctx(),
    );

    expect(result.usage.totalTokens).toBe(10);
    expect(result.usage.cost.total).toBe(0.002);
  });

  describe("the lifecycle event payload", () => {
    async function completedPayload(pi: any) {
      await flush();
      const call = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed");
      return call?.[1];
    }

    it("carries the run's spend as a pi Usage", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      });
    });

    it("carries it regardless of either setting", async () => {
      const { pi, tools } = boot({ reportUsage: false, showCost: false });
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage.cost.total).toBe(0.01);
    });

    it("keeps `tokens` as the display total it has always been", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).tokens).toEqual({ input: 100, output: 50, total: 160 });
    });

    it("omits usage entirely when nothing was spent", async () => {
      const { pi, tools } = boot({});
      runSpendingNothing();

      await spawn(tools, "tc-1");

      const payload = await completedPayload(pi);
      expect(payload.usage).toBeUndefined();
      expect(payload.tokens).toBeUndefined();
    });

    it("reports an unpriced model's tokens with a zero cost", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0 });

      await spawn(tools, "tc-1");

      const usage = (await completedPayload(pi)).usage;
      expect(usage.totalTokens).toBe(150);
      expect(usage.cost.total).toBe(0);
    });
  });

  it("reports spend through get_subagent_result too", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    await spawn(tools, undefined);
    await flush();

    const result = await tools.get("get_subagent_result").execute(
      "tc-2", { agent_id: "nope" }, undefined, undefined, ctx(),
    );

    expect(result.usage.cost.total).toBe(0.0123);
  });
});
