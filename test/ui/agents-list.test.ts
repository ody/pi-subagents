import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import type { AgentTreeNode } from "../../src/ui/agent-tree.js";
import { selectAgentRow } from "../../src/ui/agents-list.js";

const theme = { fg: (c: string, s: string) => `<${c}:${s}>`, bold: (s: string) => s };

function node(id: string, status: AgentRecord["status"], depth = 0, orphan = false): AgentTreeNode {
  const record = { id, type: "explore", description: `job ${id}`, status, toolUses: 2, startedAt: Date.now() - 1000 } as AgentRecord;
  return { record, depth, orphan };
}

const deps = { getActivity: () => undefined, showCost: false, showModel: false };

function open(nodes: AgentTreeNode[]) {
  const keys = new Map([["up", "tui.select.up"], ["down", "tui.select.down"], ["enter", "tui.select.confirm"], ["esc", "tui.select.cancel"]]);
  let component: { render(w: number): string[]; handleInput(d: string): void } | undefined;
  let finish: (value: AgentTreeNode | undefined) => void = () => {};
  const result = new Promise<AgentTreeNode | undefined>(resolve => {
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
  const selection = selectAgentRow(ui as never, nodes, deps);
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

  it("moves the selection and returns the chosen node on enter", async () => {
    const nodes = [node("a1", "completed"), node("a2", "completed")];
    const { component, selection } = open(nodes);

    component.handleInput("down");
    expect(component.render(200)[3]).toContain("<accent:▸ >");
    component.handleInput("enter");

    expect(await selection).toBe(nodes[1]);
  });

  it("returns undefined on cancel", async () => {
    const { component, selection } = open([node("a1", "completed")]);

    component.handleInput("esc");

    expect(await selection).toBeUndefined();
  });
});
