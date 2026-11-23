import { describe, expect, it, vi } from "vitest";
import { cleanup, type RetentionDeps, resolveMention } from "../../src/manager/agent-retention.js";
import { registerAgentControlTools } from "../../src/tool/agent-control-tools.js";
import { createSpawnFunnel } from "../../src/triggers/spawn-funnel.js";
import type { AgentRecord } from "../../src/types.js";

const NOW = 10_000_000;
const STALE = NOW - 10 * 60_000 - 1;

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-id",
    type: "Explore",
    handle: "audit",
    alias: "reviewer",
    description: "audit the repo",
    status: "completed",
    result: "all clear",
    toolUses: 2,
    startedAt: 1,
    completedAt: STALE,
    sessionFile: "/s/audit.jsonl",
    ...overrides,
  } as AgentRecord;
}

function setup(records: AgentRecord[], sweep = true) {
  const deps: RetentionDeps = {
    agents: new Map(records.map((agent) => [agent.id, agent])),
    activities: new Map(),
    startups: new Map(),
    tombstones: new Map(),
  };
  if (sweep) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cleanup(deps);
    vi.useRealTimers();
  }
  const manager = {
    getRecord: (id: string) => deps.agents.get(id),
    resolveMention: (name: string) => resolveMention(deps, name),
  };
  const { resolveAgentRef, resolveAgentTombstone } = createSpawnFunnel({ manager: manager as never, reloadCustomAgents: vi.fn() });
  const tools: any[] = [];
  const pi = { registerTool: (tool: any) => tools.push(tool), events: { emit: vi.fn() } } as any;
  const cancelNudge = vi.fn();
  const abort = vi.fn();
  registerAgentControlTools(pi, {
    manager: { abort, getActivity: vi.fn() } as any,
    notifier: { cancelNudge },
    settings: { showCost: false },
    resolveAgentRef,
    resolveAgentTombstone,
    usageReporting: { settings: { reportUsage: false }, pendingUsage: new Map() } as any,
  });
  const run = async (name: string, params: object): Promise<string> => {
    const tool = tools.find((candidate) => candidate.name === name);
    const result = await tool.execute("call", params, undefined, undefined, {});
    return result.content[0].text;
  };
  return { deps, run, cancelNudge, abort };
}

describe("agent_get_result from a tombstone", () => {
  it.each([
    ["id", "agent-id"],
    ["handle", "audit"],
    ["alias", "reviewer"],
  ])("answers by %s after the sweep removes the record", async (_label, ref) => {
    const { deps, run } = setup([record()]);

    expect(deps.agents.size).toBe(0);
    const text = await run("agent_get_result", { agent_id: ref });

    expect(text).toContain("Agent: agent-id");
    expect(text).toContain("Status: completed");
    expect(text).toContain("Description: audit the repo");
    expect(text).toContain("all clear");
  });

  it("reports the error and partial output of a failed run", async () => {
    const { run } = setup([record({ status: "error", error: "boom", result: "half" })]);

    const text = await run("agent_get_result", { agent_id: "audit" });

    expect(text).toContain("Status: error");
    expect(text).toContain("Error: boom");
    expect(text).toContain("half");
  });

  it("reports the stop cause of a stopped run", async () => {
    const { run } = setup([record({ status: "stopped", stopCause: "user", result: "partial" })]);

    const text = await run("agent_get_result", { agent_id: "audit" });

    expect(text).toContain("Status: stopped (STOPPED BY THE USER");
    expect(text).toContain("partial");
  });

  it("consumes nothing and cancels no nudge", async () => {
    const { deps, run, cancelNudge } = setup([record()]);
    const before = structuredClone([...deps.tombstones.values()]);

    await run("agent_get_result", { agent_id: "audit" });

    expect(cancelNudge).not.toHaveBeenCalled();
    expect([...deps.tombstones.values()]).toEqual(before);
  });

  it("prefers a live record over a tombstone with the same handle", async () => {
    const { deps, run } = setup([record()]);
    deps.agents.set("new-id", record({ id: "new-id", result: "fresh", completedAt: NOW }));

    const text = await run("agent_get_result", { agent_id: "audit" });

    expect(text).toContain("Agent: new-id");
    expect(text).toContain("fresh");
  });

  it("says not found for an unknown reference", async () => {
    const { run } = setup([record()]);
    expect(await run("agent_get_result", { agent_id: "nobody" })).toContain('Agent not found: "nobody"');
  });
});

describe("agent_steer and agent_stop with a tombstone", () => {
  it("steer replies not found", async () => {
    const { run } = setup([record()]);
    expect(await run("agent_steer", { agent_id: "audit", message: "go on" })).toContain('Agent not found: "audit"');
  });

  it("stop replies not found and aborts nothing", async () => {
    const { run, abort } = setup([record()]);
    expect(await run("agent_stop", { agent_id: "audit" })).toContain('Agent not found: "audit"');
    expect(abort).not.toHaveBeenCalled();
  });
});
