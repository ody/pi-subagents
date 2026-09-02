import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { agentKey, ancestorKeys, buildAgentTree, MAIN_KEY, resolveSelectedKey, workflowKey } from "../src/ui/agent-tree.js";

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

/** `key@depth` per row — the shape assertions below all read off this. */
function shape(nodes: readonly { key: string; depth: number }[]): string[] {
  return nodes.map(n => `${n.key}@${n.depth}`);
}

describe("buildAgentTree", () => {
  it("emits parent, child and grandchild in pre-order with increasing depth", () => {
    const parent = rec("p");
    const child = rec("c", { parentAgentId: "p" });
    const grandchild = rec("g", { parentAgentId: "c" });
    const nodes = buildAgentTree({ records: [grandchild, child, parent] });
    expect(shape(nodes)).toEqual([`${MAIN_KEY}@0`, "agent:p@0", "agent:c@1", "agent:g@2"]);
  });

  it("nests a workflow agent under its run and its nested child under it", () => {
    const owned = rec("w1", { workflowId: "run" });
    const nested = rec("n1", { parentAgentId: "w1" });
    const nodes = buildAgentTree({
      records: [owned, nested],
      workflows: [{ id: "run" }],
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["workflow:run@0", "agent:w1@1", "agent:n1@2"]);
  });

  it("orders siblings oldest first, breaking ties on id", () => {
    const a = rec("b", { startedAt: 50 });
    const b = rec("a", { startedAt: 50 });
    const c = rec("c", { startedAt: 10 });
    const nodes = buildAgentTree({ records: [a, b, c], includeMain: false });
    expect(shape(nodes)).toEqual(["agent:c@0", "agent:a@0", "agent:b@0"]);
  });

  it("omits the children of a collapsed node but keeps the node", () => {
    const parent = rec("p");
    const child = rec("c", { parentAgentId: "p" });
    const nodes = buildAgentTree({
      records: [parent, child],
      collapsed: new Set([agentKey("p")]),
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["agent:p@0"]);
    expect(nodes[0]).toMatchObject({ hasChildren: true, collapsed: true });
  });

  it("keeps an ineligible ancestor when a descendant is eligible", () => {
    const parent = rec("p", { status: "completed" });
    const child = rec("c", { parentAgentId: "p", status: "running" });
    const nodes = buildAgentTree({
      records: [parent, child],
      isEligible: r => r.status === "running",
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["agent:p@0", "agent:c@1"]);
  });

  it("drops an ineligible leaf", () => {
    const nodes = buildAgentTree({
      records: [rec("p"), rec("d", { status: "completed" })],
      isEligible: r => r.status === "running",
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["agent:p@0"]);
  });

  it("promotes a record whose parent is gone to a marked orphan root", () => {
    const nodes = buildAgentTree({ records: [rec("c", { parentAgentId: "evicted" })], includeMain: false });
    expect(shape(nodes)).toEqual(["agent:c@0"]);
    expect(nodes[0]).toMatchObject({ orphan: true });
  });

  it("promotes a workflow child whose run row was filtered out", () => {
    const nodes = buildAgentTree({ records: [rec("w", { workflowId: "gone" })], workflows: [], includeMain: false });
    expect(shape(nodes)).toEqual(["agent:w@0"]);
    expect(nodes[0]).toMatchObject({ orphan: true });
  });

  it("breaks a parent cycle instead of recursing, losing no rows", () => {
    const a = rec("a", { parentAgentId: "b" });
    const b = rec("b", { parentAgentId: "a" });
    const nodes = buildAgentTree({ records: [a, b], includeMain: false });
    expect(shape(nodes).sort()).toEqual(["agent:a@0", "agent:b@0"]);
    expect(nodes.every(n => n.kind === "agent" && n.orphan)).toBe(true);
  });

  it("flattens a 100-child workflow deterministically", () => {
    const records = Array.from({ length: 100 }, (_, i) => rec(`c${i}`, { workflowId: "run", startedAt: i }));
    const nodes = buildAgentTree({ records, workflows: [{ id: "run" }], includeMain: false });
    expect(nodes).toHaveLength(101);
    expect(nodes[1]?.key).toBe("agent:c0");
    expect(nodes[100]?.key).toBe("agent:c99");
    expect(nodes.slice(1).every(n => n.depth === 1)).toBe(true);
  });

  it("collapses that run back to a single row", () => {
    const records = Array.from({ length: 100 }, (_, i) => rec(`x${i}`, { workflowId: "run" }));
    const nodes = buildAgentTree({
      records,
      workflows: [{ id: "run" }],
      collapsed: new Set([workflowKey("run")]),
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["workflow:run@0"]);
  });

  it("keeps a settled parent whose child is still running", () => {
    const parent = rec("p", { status: "completed", completedAt: 1 });
    const child = rec("c", { parentAgentId: "p" });
    const nodes = buildAgentTree({
      records: [parent, child],
      isEligible: r => r.status === "running",
      includeMain: false,
    });
    expect(shape(nodes)).toEqual(["agent:p@0", "agent:c@1"]);
  });
});

describe("resolveSelectedKey", () => {
  const nodes = buildAgentTree({ records: [rec("p"), rec("c", { parentAgentId: "p" })], includeMain: false });

  it("keeps a key that is still visible", () => {
    expect(resolveSelectedKey(nodes, "agent:c")).toBe("agent:c");
  });

  it("falls back to the nearest visible ancestor", () => {
    expect(resolveSelectedKey(nodes, "agent:gone", ["agent:missing", "agent:p"])).toBe("agent:p");
  });

  it("falls back to the first row when nothing matches", () => {
    expect(resolveSelectedKey(nodes, "agent:gone")).toBe("agent:p");
  });

  it("returns undefined for an empty tree", () => {
    expect(resolveSelectedKey([], "agent:p")).toBeUndefined();
  });
});

describe("ancestorKeys", () => {
  it("lists ancestors nearest first", () => {
    const nodes = buildAgentTree({
      records: [rec("p"), rec("c", { parentAgentId: "p" }), rec("g", { parentAgentId: "c" })],
      includeMain: false,
    });
    expect(ancestorKeys(nodes, "agent:g")).toEqual(["agent:c", "agent:p"]);
  });

  it("is empty for a root", () => {
    expect(ancestorKeys(buildAgentTree({ records: [rec("p")], includeMain: false }), "agent:p")).toEqual([]);
  });
});
