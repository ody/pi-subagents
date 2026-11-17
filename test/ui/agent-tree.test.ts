import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import { type AgentTreeNode, buildAgentTree } from "../../src/ui/agent-tree.js";

let clock = 1000;

function rec(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status: "running",
    toolUses: 0,
    startedAt: clock++,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function shape(nodes: readonly AgentTreeNode[]): string[] {
  return nodes.map(n => `${n.record.id}@${n.depth}`);
}

describe("buildAgentTree", () => {
  it("emits parent, child and grandchild in pre-order with increasing depth", () => {
    const parent = rec("p");
    const child = rec("c", { parentAgentId: "p" });
    const grandchild = rec("g", { parentAgentId: "c" });
    expect(shape(buildAgentTree([grandchild, child, parent]))).toEqual(["p@0", "c@1", "g@2"]);
  });

  it("orders siblings oldest first, breaking ties on id", () => {
    const a = rec("b", { startedAt: 50 });
    const b = rec("a", { startedAt: 50 });
    const c = rec("c", { startedAt: 10 });
    expect(shape(buildAgentTree([a, b, c]))).toEqual(["c@0", "a@0", "b@0"]);
  });

  it("lists every record whatever its status", () => {
    const parent = rec("p", { status: "completed", completedAt: 1 });
    const child = rec("c", { parentAgentId: "p" });
    const done = rec("d", { status: "stopped", completedAt: 2 });
    expect(shape(buildAgentTree([parent, child, done]))).toEqual(["p@0", "c@1", "d@0"]);
  });

  it("promotes a record whose parent is gone to a marked orphan root", () => {
    const nodes = buildAgentTree([rec("c", { parentAgentId: "evicted" })]);
    expect(shape(nodes)).toEqual(["c@0"]);
    expect(nodes[0]).toMatchObject({ orphan: true });
  });

  it("does not mark a top-level record or a child as an orphan", () => {
    const nodes = buildAgentTree([rec("p"), rec("c", { parentAgentId: "p" })]);
    expect(nodes.map(n => n.orphan)).toEqual([false, false]);
  });

  it("breaks a parent cycle instead of recursing, losing no rows", () => {
    const a = rec("a", { parentAgentId: "b" });
    const b = rec("b", { parentAgentId: "a" });
    const nodes = buildAgentTree([a, b]);
    expect(shape(nodes).sort()).toEqual(["a@0", "b@0"]);
    expect(nodes.every(n => n.orphan)).toBe(true);
  });
});
