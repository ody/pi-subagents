import { describe, expect, it, vi } from "vitest";
import { registerAgentControlTools } from "../src/agent-control-tools.js";
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
