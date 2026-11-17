import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-format.js";
import type { AgentTreeNode } from "./agent-tree.js";
import { finishedRowLine, type RowLineDeps, runningRowLines } from "./widget-row-lines.js";

const MAX_VISIBLE_ROWS = 12;

interface AgentsListUI {
  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void },
  ): Promise<T>;
}

function rowText(node: AgentTreeNode, selected: boolean, theme: Theme, deps: RowLineDeps): string {
  const { record, depth } = node;
  const line =
    record.status === "running" || record.status === "queued"
      ? runningRowLines(record, depth, selected, theme, "", deps)[0]
      : finishedRowLine(record, depth, selected, theme, deps);
  return node.orphan ? `${line} ${theme.fg("dim", "· detached")}` : line;
}

function windowStart(index: number, total: number): number {
  const start = index - Math.floor(MAX_VISIBLE_ROWS / 2);
  return Math.max(0, Math.min(start, total - MAX_VISIBLE_ROWS));
}

export function selectAgentRow(
  ui: AgentsListUI,
  nodes: readonly AgentTreeNode[],
  deps: RowLineDeps,
): Promise<AgentTreeNode | undefined> {
  return ui.custom<AgentTreeNode | undefined>((tui, theme, keybindings, done) => {
    let index = 0;
    return {
      render: width => {
        const start = windowStart(index, nodes.length);
        const rows = nodes
          .slice(start, start + MAX_VISIBLE_ROWS)
          .map((node, offset) => truncateToWidth(rowText(node, start + offset === index, theme, deps), width));
        const hint = theme.fg("dim", "↑↓ navigate · enter open · esc cancel");
        return [theme.fg("accent", theme.bold("Agents")), "", ...rows, "", truncateToWidth(hint, width)];
      },
      invalidate: () => {},
      handleInput: data => {
        if (keybindings.matches(data, "tui.select.up")) index = (index + nodes.length - 1) % nodes.length;
        else if (keybindings.matches(data, "tui.select.down")) index = (index + 1) % nodes.length;
        else if (keybindings.matches(data, "tui.select.confirm")) done(nodes[index]);
        else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
        tui.requestRender();
      },
    };
  });
}
