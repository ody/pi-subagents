import { describe, expect, it, vi } from "vitest";
import { formatResultStats, registerAgentControlTools, resultBody } from "../src/agent-control-tools.js";
import type { AgentRecord } from "../src/types.js";

function setup(record: AgentRecord) {
  const tools: any[] = [];
  const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
  const cancelNudge = vi.fn();
  registerAgentControlTools(pi, {
    manager: { abort: vi.fn(), getActivity: vi.fn() } as any,
    notifier: { cancelNudge },
    settings: { showCost: false },
    // Mirrors the real resolver: an id, a handle or an alias all reach the record.
    resolveAgentRef: (ref: string) => (ref === record.id || ref === record.handle ? record : undefined),
    usageReporting: { settings: { reportUsage: false }, pendingUsage: new Map() } as any,
  });
  const getResult = tools.find((tool) => tool.name === "get_subagent_result");
  return { getResult, cancelNudge };
}

function completedRecord(): AgentRecord {
  return {
    id: "agent-123",
    handle: "explore",
    type: "Explore",
    description: "look around",
    status: "completed",
    result: "done",
    toolUses: 0,
    startedAt: 0,
    completedAt: 1,
  } as AgentRecord;
}

describe("get_subagent_result nudge cancellation", () => {
  it("cancels the pending nudge by record id when called with the id", async () => {
    const record = completedRecord();
    const { getResult, cancelNudge } = setup(record);

    await getResult.execute("call-1", { agent_id: "agent-123" }, undefined, undefined, {});

    expect(record.resultConsumed).toBe(true);
    expect(cancelNudge).toHaveBeenCalledWith("agent-123");
  });

  it("cancels the pending nudge by record id when called with a handle", async () => {
    const record = completedRecord();
    const { getResult, cancelNudge } = setup(record);

    await getResult.execute("call-1", { agent_id: "explore" }, undefined, undefined, {});

    expect(record.resultConsumed).toBe(true);
    expect(cancelNudge).toHaveBeenCalledWith("agent-123");
  });

  it("leaves the nudge alone while the agent is still running", async () => {
    const record = { ...completedRecord(), status: "running" } as AgentRecord;
    const { getResult, cancelNudge } = setup(record);

    await getResult.execute("call-1", { agent_id: "explore" }, undefined, undefined, {});

    expect(record.resultConsumed).toBeFalsy();
    expect(cancelNudge).not.toHaveBeenCalled();
  });
});

function sessionWith(percent: number | null, messages: unknown[] = []) {
  return {
    getSessionStats: () => ({ contextUsage: percent === null ? undefined : { percent } }),
    messages,
  } as any;
}

function resultText(result: any): string {
  return result.content[0].text;
}

describe("get_subagent_result stats line", () => {
  it("reports context percent rounded, and compactions", async () => {
    const record = { ...completedRecord(), session: sessionWith(41.6), compactionCount: 2 } as AgentRecord;
    const { getResult } = setup(record);

    const text = resultText(await getResult.execute("c", { agent_id: "explore" }, undefined, undefined, {}));

    expect(text).toContain("Context: 42%");
    expect(text).toContain("Compactions: 2");
  });

  it("omits context and compactions when unknown or zero", async () => {
    const { getResult } = setup(completedRecord());

    const text = resultText(await getResult.execute("c", { agent_id: "explore" }, undefined, undefined, {}));

    expect(text).not.toContain("Context:");
    expect(text).not.toContain("Compactions:");
    expect(text).toContain("Tool uses: 0 | Duration:");
  });
});

describe("formatResultStats", () => {
  const base = { toolUses: 3, startedAt: 0, completedAt: 1000, lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.5 } } as AgentRecord;

  it("joins tool uses, tokens, cost, context, compactions and duration in order", () => {
    const record = { ...base, session: sessionWith(10), compactionCount: 1 } as AgentRecord;
    const parts = formatResultStats(record, true).split(" | ");
    expect(parts[0]).toBe("Tool uses: 3");
    expect(parts[2]).toMatch(/^Cost: /);
    expect(parts.slice(3, 5)).toEqual(["Context: 10%", "Compactions: 1"]);
    expect(parts.at(-1)).toMatch(/^Duration: /);
  });

  it("omits cost when showCost is off", () => {
    expect(formatResultStats(base, false)).not.toContain("Cost:");
  });
});

describe("resultBody", () => {
  it("says a running agent is still running", () => {
    expect(resultBody({ ...completedRecord(), status: "running" } as AgentRecord)).toContain("still running");
  });

  it("reports an error with partial output", () => {
    const body = resultBody({ ...completedRecord(), status: "error", error: "boom", result: "half" } as AgentRecord);
    expect(body).toContain("Error: boom");
    expect(body).toContain("half");
  });

  it("returns the trimmed result, or a placeholder", () => {
    expect(resultBody({ ...completedRecord(), result: "  hi \n" } as AgentRecord)).toBe("hi");
    expect(resultBody({ ...completedRecord(), result: "  " } as AgentRecord)).toBe("No output.");
  });
});

describe("get_subagent_result verbose and consume", () => {
  const messages = [{ role: "user", content: "hello there" }];

  it("appends the conversation when verbose", async () => {
    const record = { ...completedRecord(), session: sessionWith(null, messages) } as AgentRecord;
    const { getResult, cancelNudge } = setup(record);

    const text = resultText(await getResult.execute("c", { agent_id: "explore", verbose: true }, undefined, undefined, {}));

    expect(text).toContain("done\n\n--- Agent Conversation ---\n[User]: hello there");
    expect(cancelNudge).toHaveBeenCalledWith("agent-123");
  });

  it("omits the conversation when not verbose", async () => {
    const record = { ...completedRecord(), session: sessionWith(null, messages) } as AgentRecord;
    const { getResult } = setup(record);

    const text = resultText(await getResult.execute("c", { agent_id: "explore" }, undefined, undefined, {}));

    expect(text).not.toContain("Agent Conversation");
  });
});
