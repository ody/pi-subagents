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

function rebuild(state: RetentionDeps, entries: unknown[], treeChanged = false): void {
  rebuildTombstones(state, entries as Branch, treeChanged);
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

  it("does not resurrect an older id after its newer entry loses a handle collision", () => {
    const state = deps();
    rebuild(state, [entry({ id: "B", handle: "h2", completedAt: 1 }), entry({ id: "B", handle: "h1", completedAt: 2 }), entry({ id: "A", handle: "h1", completedAt: 3 })]);
    expect([...state.tombstones.keys()]).toEqual(["h1"]);
    expect(state.tombstones.get("h1")?.id).toBe("A");
  });

  it("copies a valid worktree resume state and drops a malformed one", () => {
    const state = deps();
    const worktree = { path: "/w", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/w", repoPath: "/repo", cwd: "/w" };
    rebuild(state, [
      entry({ handle: "kept", worktree }),
      entry({ id: "bad", handle: "bad", completedAt: 2, worktree: { path: "/w" } as never }),
    ]);
    expect(state.tombstones.get("kept")?.worktree).toEqual(worktree);
    expect(state.tombstones.get("bad")).not.toHaveProperty("worktree");
  });

  it("prefers the later branch entry when completion times tie", () => {
    const state = deps();
    rebuild(state, [entry({ id: "first" }), entry({ id: "last" })]);
    expect(state.tombstones.get("handle")?.id).toBe("last");
  });

  it("removes settled records outside the branch while keeping active and nested agents", () => {
    const state = deps();
    const session = { dispose: () => {} };
    state.agents.set("old", { id: "old", handle: "handle", status: "completed", session } as unknown as AgentRecord);
    state.agents.set("active", { id: "active", handle: "active", status: "completed", completedAt: 1 } as AgentRecord);
    state.agents.set("running", { id: "running", handle: "running", status: "running" } as AgentRecord);
    state.agents.set("queued", { id: "queued", handle: "queued", status: "queued" } as AgentRecord);
    state.agents.set("nested", { id: "nested", parentAgentId: "running", status: "completed" } as AgentRecord);
    rebuild(state, [entry({ id: "new" }), entry({ id: "active", handle: "active" })], true);
    expect([...state.agents.keys()]).toEqual(["active", "running", "queued", "nested"]);
    expect(state.tombstones.get("handle")?.id).toBe("new");
    expect(state.tombstones.has("active")).toBe(false);
  });

  it("discards a later live run when the branch contains only an earlier run of the same agent", () => {
    const state = deps();
    state.agents.set("id", { id: "id", handle: "handle", status: "completed", startedAt: 2, completedAt: 3 } as AgentRecord);
    rebuild(state, [entry({ result: "earlier" })], true);
    expect(state.agents.has("id")).toBe(false);
    expect(state.tombstones.get("handle")?.result).toBe("earlier");
  });

  it("retains the newest 100 tombstones", () => {
    const state = deps();
    rebuild(state, Array.from({ length: 110 }, (_, i) => entry({ id: `${i}`, handle: `${i}`, completedAt: i })));
    expect(state.tombstones.size).toBe(100);
    expect(state.tombstones.has("9")).toBe(false);
    expect(state.tombstones.has("10")).toBe(true);
  });
});
