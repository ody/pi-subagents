import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentTombstone } from "../types.js";
import type { Theme } from "./agent-format.js";
import type { AgentTreeNode } from "./agent-tree.js";
import type { ViewerAgent } from "./conversation-viewer-opener.js";
import { finishedRowLine, historyRowLine, type RowLineDeps, runningRowLines } from "./widget-row-lines.js";

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

type ListRow =
  | { kind: "heading"; label: string }
  | { kind: "live"; node: AgentTreeNode }
  | { kind: "history"; entry: AgentTombstone };

function buildRows(nodes: readonly AgentTreeNode[], history: readonly AgentTombstone[]): ListRow[] {
  const rows: ListRow[] = nodes.map(node => ({ kind: "live", node }));
  if (history.length > 0) {
    rows.push({ kind: "heading", label: "History" });
    for (const entry of history) rows.push({ kind: "history", entry });
  }
  return rows;
}

function liveRowLine(node: AgentTreeNode, selected: boolean, theme: Theme, deps: RowLineDeps): string {
  const { record, depth } = node;
  const line =
    record.status === "running" || record.status === "queued"
      ? runningRowLines(record, depth, selected, theme, "", deps)[0]
      : finishedRowLine(record, depth, selected, theme, deps);
  return node.orphan ? `${line} ${theme.fg("dim", "· detached")}` : line;
}

function rowLine(row: ListRow, selected: boolean, theme: Theme, deps: RowLineDeps): string {
  if (row.kind === "heading") return theme.fg("muted", theme.bold(row.label));
  if (row.kind === "history") return historyRowLine(row.entry, selected, theme);
  return liveRowLine(row.node, selected, theme, deps);
}

function rowSelection(row: ListRow | undefined): ViewerAgent | undefined {
  if (row?.kind === "live") return { kind: "live", record: row.node.record };
  if (row?.kind === "history") return { kind: "history", entry: row.entry };
  return undefined;
}

function selectableIndexes(rows: readonly ListRow[]): number[] {
  return rows.flatMap((row, index) => (row.kind === "heading" ? [] : [index]));
}

function step(index: number, delta: number, selectable: readonly number[]): number {
  if (selectable.length === 0) return index;
  const at = selectable.indexOf(index);
  const from = at === -1 ? 0 : at;
  return selectable[(from + delta + selectable.length) % selectable.length];
}

function movedIndex(data: string, keybindings: KeybindingsManager, index: number, selectable: readonly number[]): number | undefined {
  if (keybindings.matches(data, "tui.select.up")) return step(index, -1, selectable);
  if (keybindings.matches(data, "tui.select.down")) return step(index, 1, selectable);
  return undefined;
}

function windowStart(index: number, total: number): number {
  const start = index - Math.floor(MAX_VISIBLE_ROWS / 2);
  return Math.max(0, Math.min(start, total - MAX_VISIBLE_ROWS));
}

export function selectAgentRow(
  ui: AgentsListUI,
  nodes: readonly AgentTreeNode[],
  deps: RowLineDeps,
  history: readonly AgentTombstone[] = [],
): Promise<ViewerAgent | undefined> {
  return ui.custom<ViewerAgent | undefined>((tui, theme, keybindings, done) => {
    const rows = buildRows(nodes, history);
    const selectable = selectableIndexes(rows);
    let index = selectable[0] ?? 0;
    return {
      render: width => {
        const start = windowStart(index, rows.length);
        const lines = rows
          .slice(start, start + MAX_VISIBLE_ROWS)
          .map((row, offset) => truncateToWidth(rowLine(row, start + offset === index, theme, deps), width));
        const hint = theme.fg("dim", "↑↓ navigate · enter open · esc cancel");
        return [theme.fg("accent", theme.bold("Agents")), "", ...lines, "", truncateToWidth(hint, width)];
      },
      invalidate: () => {},
      handleInput: data => {
        const moved = movedIndex(data, keybindings, index, selectable);
        if (moved !== undefined) index = moved;
        else if (keybindings.matches(data, "tui.select.confirm")) {
          const selection = rowSelection(rows[index]);
          if (selection) done(selection);
        } else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
        tui.requestRender();
      },
    };
  });
}
