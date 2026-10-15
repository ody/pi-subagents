import { describe, expect, it } from "vitest";
import { type RetentionDeps, resolveMention, takenHandles } from "../src/agent-retention.js";
import type { AgentRecord, AgentTombstone } from "../src/types.js";

function record(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent-id",
    type: "Explore",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: 1,
    ...overrides,
  } as AgentRecord;
}

function retentionDeps(records: AgentRecord[] = [], entries: AgentTombstone[] = []): RetentionDeps {
  return {
    agents: new Map(records.map(agent => [agent.id, agent])),
    activities: new Map(),
    startups: new Map(),
    tombstones: new Map(entries.map(entry => [entry.handle, entry])),
  };
}

function tombstone(overrides: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle: "explore",
    id: "old-agent",
    type: "Explore",
    description: "old session",
    sessionFile: "/sessions/explore.jsonl",
    completedAt: 1,
    ...overrides,
  };
}

describe("agent retention lookups", () => {
  it("reserves live and tombstoned handles and aliases", () => {
    const deps = retentionDeps(
      [record({ handle: "explore", alias: "audit" })],
      [tombstone({ handle: "plan", alias: "planning" })],
    );

    expect(takenHandles(deps)).toEqual(new Set(["explore", "audit", "plan", "planning"]));
  });

  it("resolves a live handle before a matching tombstone", () => {
    const live = record({ handle: "Explore", status: "running" });
    const resolved = resolveMention(retentionDeps([live], [tombstone()]), "explore");

    expect(resolved).toEqual({ kind: "live", record: live });
  });

  it("excludes nested records and resolves a tombstone by alias", () => {
    const child = record({ id: "child-id", handle: "explore", parentAgentId: "parent" });
    const entry = tombstone({ alias: "audit" });

    expect(resolveMention(retentionDeps([child], [entry]), "audit")).toEqual({ kind: "tombstone", entry });
  });
});
