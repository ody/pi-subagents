import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type RetentionDeps, rebuildTombstones } from "../../src/manager/agent-retention.js";
import type { AgentRecord, AgentTombstone } from "../../src/types.js";

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

function entry(overrides: Partial<AgentTombstone> = {}) {
  return { type: "custom", customType: "agent:record", data: {
    id: "id", handle: "handle", type: "explore", description: "test", sessionFile: "/session", completedAt: 1,
    status: "completed", ...overrides,
  } };
}

function deps(): RetentionDeps {
  return { agents: new Map(), activities: new Map(), startups: new Map(), tombstones: new Map() };
}

function rebuild(state: RetentionDeps, entries: unknown[]): void {
  rebuildTombstones(state, entries as Branch);
}

describe("active branch tombstone rebuilding", () => {
  it("copies durable fields and ignores other entries and records without a handle or session file", () => {
    const state = deps();
    const data = { alias: "alias", status: "stopped" as const, result: "partial", error: "error", stopCause: "user" as const, agentConfig: { name: "config" } as AgentTombstone["agentConfig"] };
    rebuild(state, [entry(data), entry({ id: "no-handle", handle: "" }), entry({ id: "no-file", handle: "other", sessionFile: "" }), { type: "custom", customType: "other", data: entry().data }]);
    expect(state.tombstones.size).toBe(1);
    expect(state.tombstones.get("handle")).toMatchObject(data);
  });

  it("replaces tombstones when the active branch changes", () => {
    const state = deps();
    rebuild(state, [entry()]);
    rebuild(state, [entry({ id: "new", handle: "new" })]);
    expect([...state.tombstones.keys()]).toEqual(["new"]);
  });

  it("keeps the latest entry for a repeated id", () => {
    const state = deps();
    rebuild(state, [entry({ handle: "new", completedAt: 3 }), entry({ handle: "old", completedAt: 2 })]);
    expect([...state.tombstones.keys()]).toEqual(["new"]);
  });

  it("keeps the latest entry for a repeated handle", () => {
    const state = deps();
    rebuild(state, [entry({ id: "old", completedAt: 2 }), entry({ id: "new", completedAt: 3 })]);
    expect(state.tombstones.get("handle")?.id).toBe("new");
  });

  it("lets live handles and ids win", () => {
    const state = deps();
    state.agents.set("live", { id: "live", handle: "HANDLE" } as AgentRecord);
    rebuild(state, [entry(), entry({ id: "live", handle: "other" })]);
    expect(state.tombstones.size).toBe(0);
  });

  it("retains the newest 100 tombstones", () => {
    const state = deps();
    rebuild(state, Array.from({ length: 110 }, (_, i) => entry({ id: `${i}`, handle: `${i}`, completedAt: i })));
    expect(state.tombstones.size).toBe(100);
    expect(state.tombstones.has("9")).toBe(false);
    expect(state.tombstones.has("10")).toBe(true);
  });
});
