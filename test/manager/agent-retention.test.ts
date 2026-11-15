import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, type RetentionDeps, removeRecord, resolveMention, takenHandles } from "../../src/manager/agent-retention.js";
import type { AgentConfig, AgentRecord, AgentTombstone } from "../../src/types.js";

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

describe("tombstone agent config", () => {
  const config = { name: "ephemeral-0123abcd", systemPrompt: "" } as AgentConfig;

  function remove(overrides: Partial<AgentRecord>): RetentionDeps {
    const deps = retentionDeps([record(overrides)]);
    removeRecord(deps, "agent-id", deps.agents.get("agent-id") as AgentRecord);
    return deps;
  }

  it("copies the stored config onto the tombstone", () => {
    const deps = remove({ handle: "audit", sessionFile: "/s/a.jsonl", agentConfig: config });
    expect(deps.tombstones.get("audit")?.agentConfig).toBe(config);
  });

  it("leaves no tombstone without a session file", () => {
    expect(remove({ handle: "audit", agentConfig: config }).tombstones.size).toBe(0);
  });

  it("leaves no tombstone for an agent with a parent, which has no handle", () => {
    const deps = remove({ parentAgentId: "parent", sessionFile: "/s/a.jsonl", agentConfig: config });
    expect(deps.tombstones.size).toBe(0);
  });
});

describe("retention sweep", () => {
  const NOW = 10_000_000;
  const STALE = NOW - 10 * 60_000 - 1;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function sweep(records: AgentRecord[], isNotificationPending?: (id: string) => boolean): RetentionDeps {
    const deps = { ...retentionDeps(records), isNotificationPending };
    cleanup(deps);
    return deps;
  }

  it("removes a stale unconsumed record", () => {
    const deps = sweep([record({ completedAt: STALE })]);
    expect(deps.agents.size).toBe(0);
  });

  it("marks a record consumed before it removes it", () => {
    const stale = record({ completedAt: STALE });
    sweep([stale]);
    expect(stale.resultConsumed).toBe(true);
  });

  it("skips a stale record while its notification is pending, and leaves it unconsumed", () => {
    const stale = record({ completedAt: STALE });
    const isNotificationPending = vi.fn(() => true);

    const deps = sweep([stale], isNotificationPending);

    expect(isNotificationPending).toHaveBeenCalledWith("agent-id");
    expect(deps.agents.has("agent-id")).toBe(true);
    expect(stale.resultConsumed).toBeFalsy();
  });

  it("removes the record on a later sweep once the notification is no longer pending", () => {
    const stale = record({ completedAt: STALE });
    let pending = true;
    const deps = { ...retentionDeps([stale]), isNotificationPending: () => pending };

    cleanup(deps);
    expect(deps.agents.size).toBe(1);

    pending = false;
    cleanup(deps);
    expect(deps.agents.size).toBe(0);
    expect(stale.resultConsumed).toBe(true);
  });

  it("leaves a recent record alone and does not consume it", () => {
    const recent = record({ completedAt: NOW - 60_000 });
    const deps = sweep([recent]);
    expect(deps.agents.size).toBe(1);
    expect(recent.resultConsumed).toBeFalsy();
  });

  it("leaves a running record alone", () => {
    const running = record({ status: "running", completedAt: STALE });
    expect(sweep([running]).agents.size).toBe(1);
    expect(running.resultConsumed).toBeFalsy();
  });

  it("still tombstones a removed record with a handle and a session file", () => {
    const deps = sweep([record({ completedAt: STALE, handle: "audit", sessionFile: "/s/a.jsonl" })]);
    expect(deps.tombstones.get("audit")?.id).toBe("agent-id");
  });
});
