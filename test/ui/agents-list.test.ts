import { describe, expect, it } from "vitest";
import type { AgentRecord, AgentTombstone } from "../../src/types.js";
import type { AgentTreeNode } from "../../src/ui/agent-tree.js";
import { selectAgentRow } from "../../src/ui/agents-list.js";
import type { ViewerAgent } from "../../src/ui/conversation-viewer-opener.js";

const theme = { fg: (c: string, s: string) => `<${c}:${s}>`, bold: (s: string) => s };

function node(id: string, status: AgentRecord["status"], depth = 0, orphan = false): AgentTreeNode {
  const record = { id, type: "explore", description: `job ${id}`, status, toolUses: 2, startedAt: Date.now() - 1000 } as AgentRecord;
  return { record, depth, orphan };
}

function tombstone(handle: string, over: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle,
    id: `id-${handle}`,
    type: "explore",
    description: `done ${handle}`,
    sessionFile: `/sessions/${handle}.jsonl`,
    completedAt: Date.now() - 120_000,
    status: "completed",
    ...over,
  };
}

const deps = { getActivity: () => undefined, showCost: false, showModel: false };

function open(nodes: AgentTreeNode[], history: AgentTombstone[] = []) {
  const keys = new Map([["up", "tui.select.up"], ["down", "tui.select.down"], ["enter", "tui.select.confirm"], ["esc", "tui.select.cancel"]]);
  let component: { render(w: number): string[]; handleInput(d: string): void } | undefined;
  let finish: (value: ViewerAgent | undefined) => void = () => {};
  const result = new Promise<ViewerAgent | undefined>(resolve => {
    finish = resolve;
  });
  const ui = {
    custom: (factory: (...args: never[]) => typeof component) => {
      component = (factory as (...args: unknown[]) => typeof component)(
        { requestRender: () => {} },
        theme,
        { matches: (data: string, id: string) => keys.get(data) === id },
        finish,
      );
      return result;
    },
  };
  const selection = selectAgentRow(ui as never, nodes, deps, history);
  return { component: component as NonNullable<typeof component>, selection };
}

describe("selectAgentRow", () => {
  it("draws rows like the Agents widget with status icons and connectors", () => {
    const { component } = open([node("a1", "completed"), node("a2", "running", 1)]);
    const lines = component.render(200);

    expect(lines[0]).toContain("Agents");
    expect(lines[2]).toContain("<accent:▸ >");
    expect(lines[2]).toContain("<success:✓>");
    expect(lines[3]).toContain("<dim:├─>");
    expect(lines[3]).toContain("<accent:●>");
  });

  it("marks a detached agent", () => {
    const { component } = open([node("a1", "completed", 0, true)]);

    expect(component.render(200)[2]).toContain("detached");
  });

  it("moves the selection and returns the chosen live record on enter", async () => {
    const nodes = [node("a1", "completed"), node("a2", "completed")];
    const { component, selection } = open(nodes);

    component.handleInput("down");
    expect(component.render(200)[3]).toContain("<accent:▸ >");
    component.handleInput("enter");

    expect(await selection).toEqual({ kind: "live", record: nodes[1].record });
  });

  it("returns undefined on cancel", async () => {
    const { component, selection } = open([node("a1", "completed")]);

    component.handleInput("esc");

    expect(await selection).toBeUndefined();
  });
});

describe("selectAgentRow history", () => {
  it("lists finished agents under a History heading below the tree", () => {
    const { component } = open([node("a1", "completed")], [tombstone("fixer")]);
    const lines = component.render(200);
    const heading = lines.findIndex(line => line.includes("History"));
    const live = lines.findIndex(line => line.includes("job a1"));
    const history = lines.findIndex(line => line.includes("done fixer"));

    expect(live).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(live);
    expect(history).toBeGreaterThan(heading);
  });

  it("draws a history row with the status icon, handle, type, description and age", () => {
    const { component } = open([], [tombstone("fixer")]);
    const row = component.render(200).find(line => line.includes("done fixer")) ?? "";

    expect(row).toContain("<success:✓>");
    expect(row).toContain("<dim:fixer>");
    expect(row).toContain("<muted:explore>");
    expect(row).toContain("<muted:done fixer>");
    expect(row).toContain("<muted:2m ago>");
  });

  it("shows the alias in place of the handle and the agent config name as the type", () => {
    const entry = tombstone("one-off", {
      alias: "reviewer",
      description: "checked the diff",
      type: "ephemeral-1a2b3c4d",
      agentConfig: { displayName: "Fixer" } as AgentTombstone["agentConfig"],
    });
    const row = open([], [entry]).component.render(200).find(line => line.includes("checked the diff")) ?? "";

    expect(row).toContain("reviewer");
    expect(row).not.toContain("one-off");
    expect(row).toContain("<muted:Fixer>");
  });

  it("starts on the first history row when there is no live agent", () => {
    const { component } = open([], [tombstone("fixer")]);

    expect(component.render(200).find(line => line.includes("done fixer"))).toContain("<accent:▸ >");
  });

  it("skips the History heading when moving the selection", async () => {
    const entry = tombstone("fixer");
    const { component, selection } = open([node("a1", "completed")], [entry]);

    component.handleInput("down");
    component.handleInput("enter");

    expect(await selection).toEqual({ kind: "history", entry });
  });

  it("returns the tombstone on enter", async () => {
    const entry = tombstone("fixer");
    const { component, selection } = open([], [entry]);

    component.handleInput("enter");

    expect(await selection).toEqual({ kind: "history", entry });
  });

  it("draws no History heading without tombstones", () => {
    const { component } = open([node("a1", "completed")], []);

    expect(component.render(200).join("\n")).not.toContain("History");
  });
});
