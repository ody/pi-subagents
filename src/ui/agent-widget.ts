import { Editor, isKeyRelease, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentRecord, WidgetMode } from "../types.js";
import { renderStatusIcon, SPINNER, statusPresentation, type Theme } from "./agent-format.js";
import type { ConversationViewerOpener, ViewerUI } from "./conversation-viewer-opener.js";
import { layoutWidgetBody, type WidgetSections } from "./widget-layout.js";
import { finishedRowLine, type RowLineDeps, runningRowLines } from "./widget-row-lines.js";
import { agentRowIds, collectWidgetRows, type WidgetRows } from "./widget-rows.js";
import { WidgetSelection } from "./widget-selection.js";

const MAX_WIDGET_LINES = 12;
const MANAGE_HINT = "↓ to manage";
const SELECTING_HINT = "↑↓ select · enter open · esc done";

type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

export type SelectionUICtx = ViewerUI & {
  onTerminalInput(handler: (data: string) => TerminalInputResult): () => void;
  getEditorText(): string;
};

export function statusBarText(running: number, queued: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return `${parts.join(", ")} agent${running + queued === 1 ? "" : "s"}`;
}

function editorHasFocus(tui: TUI | undefined): boolean {
  const focused = (tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
  return focused == null || focused instanceof Editor;
}

function hasNoRows(rows: WidgetRows): boolean {
  return rows.running.length === 0 && rows.queued.length === 0 && rows.finished.length === 0;
}

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private finishedTurnAge = new Map<string, number>();
  private static readonly ERROR_LINGER_TURNS = 2;

  private widgetRegistered = false;
  private tui: TUI | undefined;
  private lastStatusText: string | undefined;
  private inputCtx: SelectionUICtx | undefined;
  private inputUnsub: (() => void) | undefined;
  private readonly selection = new WidgetSelection();
  private viewingId: string | undefined;

  constructor(
    private manager: AgentManager,
    private mode: () => WidgetMode = () => "all",
    private showCost: () => boolean = () => false,
    private showModel: () => boolean = () => false,
    private viewer: Pick<ConversationViewerOpener, "open">,
  ) {}

  setUICtx(ctx: UICtx) {
    if (ctx === this.uiCtx) return;
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }

  setInputCtx(ctx: SelectionUICtx) {
    if (ctx === this.inputCtx) return;
    this.inputUnsub?.();
    this.inputCtx = ctx;
    this.inputUnsub = ctx.onTerminalInput(data => this.handleKey(data));
  }

  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    this.update();
  }

  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  private shouldShowFinished(agentId: string, status: AgentRecord["status"]): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = statusPresentation(status).statusClass === "failure" ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  markRunning(agentId: string) {
    this.finishedTurnAge.delete(agentId);
  }

  private heldIds(records: readonly AgentRecord[]): Set<string> {
    const held = new Set<string>();
    if (this.viewingId !== undefined) held.add(this.viewingId);
    const selectedId = this.selection.selectedId;
    const selected = selectedId === undefined ? undefined : records.find(record => record.id === selectedId);
    if (selected?.parentAgentId !== undefined) held.add(selected.id);
    return held;
  }

  private snapshot(): { records: AgentRecord[]; rows: WidgetRows; ids: string[] } {
    const records = this.manager.listAgents();
    const rows = collectWidgetRows({
      records,
      mode: this.mode(),
      lingers: record => this.shouldShowFinished(record.id, record.status),
      held: this.heldIds(records),
    });
    const ids = agentRowIds(rows);
    this.selection.reconcile(ids);
    return { records, rows, ids };
  }

  private canStartSelection(tui: TUI, ids: readonly string[]): boolean {
    return ids.length > 0 && editorHasFocus(tui) && this.inputCtx?.getEditorText() === "";
  }

  private handleKey(data: string): TerminalInputResult {
    if (!this.inputCtx || isKeyRelease(data) || this.viewingId !== undefined) return undefined;
    const { ids } = this.snapshot();
    if (!editorHasFocus(this.tui)) {
      if (this.selection.active) this.endSelection();
      return undefined;
    }

    if (!this.selection.active) {
      if (!matchesKey(data, "down") || this.inputCtx.getEditorText() !== "" || !this.selection.start(ids)) return undefined;
      this.update();
      return { consume: true };
    }

    if (matchesKey(data, "down")) this.selection.moveDown(ids);
    else if (matchesKey(data, "up")) this.selection.moveUp(ids);
    else if (matchesKey(data, "escape")) this.selection.end();
    else if (matchesKey(data, "enter")) this.openSelected();
    else {
      this.endSelection();
      return undefined;
    }
    this.update();
    return { consume: true };
  }

  private endSelection(): void {
    this.selection.end();
    this.update();
  }

  private openSelected(): void {
    const selectedId = this.selection.selectedId;
    const record = this.manager.listAgents().find(candidate => candidate.id === selectedId);
    if (!record || !this.inputCtx) {
      this.selection.end();
      return;
    }
    this.viewingId = record.id;
    this.viewer.open(this.inputCtx, record).then(() => this.closeViewer(), () => this.closeViewer());
  }

  private closeViewer(): void {
    if (this.viewingId === undefined) return;
    this.selection.follow(this.viewingId);
    this.viewingId = undefined;
    this.update();
  }

  private renderWidget(tui: TUI, theme: Theme): string[] {
    const { rows, ids } = this.snapshot();
    if (hasNoRows(rows)) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const hasActive = rows.running.length > 0 || rows.queued.length > 0;
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];
    const deps: RowLineDeps = { getActivity: id => this.manager.getActivity(id), showCost: this.showCost(), showModel: this.showModel() };
    const selectedId = this.selection.selectedId;

    const sections: WidgetSections = {
      finished: rows.finished.map(({ record, depth }) => truncate(finishedRowLine(record, depth, record.id === selectedId, theme, deps))),
      running: rows.running.map(({ record, depth }) => runningRowLines(record, depth, record.id === selectedId, theme, frame, deps).map(truncate) as [string, string]),
      queued: rows.queued.length > 0
        ? truncate(theme.fg("dim", "├─") + ` ${renderStatusIcon(theme, "queued")} ${theme.fg("dim", `${rows.queued.length} queued`)}`)
        : undefined,
    };
    const finishedIndex = rows.finished.findIndex(row => row.record.id === selectedId);
    const runningIndex = rows.running.findIndex(row => row.record.id === selectedId);
    if (finishedIndex >= 0) sections.pinned = { section: "finished", index: finishedIndex };
    else if (runningIndex >= 0) sections.pinned = { section: "running", index: runningIndex };

    let hint = "";
    if (this.selection.active) hint = " " + theme.fg("dim", SELECTING_HINT);
    else if (this.canStartSelection(tui, ids)) hint = " " + theme.fg("dim", MANAGE_HINT);
    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents") + hint)];
    const { body, hidden } = layoutWidgetBody(sections, MAX_WIDGET_LINES - 1);
    lines.push(...body);
    if (hidden) {
      const overflowParts: string[] = [];
      if (hidden.running > 0) overflowParts.push(`${hidden.running} running`);
      if (hidden.finished > 0) overflowParts.push(`${hidden.finished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hidden.running + hidden.finished} more (${overflowText})`)}`));
    }

    return lines;
  }

  update() {
    if (!this.uiCtx) return;
    const { records, rows } = this.snapshot();

    if (hasNoRows(rows)) {
      this.clearWidget(records);
      return;
    }

    const hasActive = rows.runningTopLevel > 0 || rows.queued.length > 0;
    const newStatusText = hasActive ? statusBarText(rows.runningTopLevel, rows.queued.length) : undefined;
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;
    this.registerWidget(this.uiCtx);
  }

  private clearWidget(records: readonly AgentRecord[]) {
    if (this.uiCtx && this.widgetRegistered) {
      this.uiCtx.setWidget("agents", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.uiCtx && this.lastStatusText !== undefined) {
      this.uiCtx.setStatus("subagents", undefined);
      this.lastStatusText = undefined;
    }
    if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
    for (const [id] of this.finishedTurnAge) {
      if (!records.some(a => a.id === id)) this.finishedTurnAge.delete(id);
    }
  }

  private registerWidget(uiCtx: UICtx) {
    if (this.widgetRegistered) {
      this.tui?.requestRender();
      return;
    }
    uiCtx.setWidget("agents", (tui, theme) => {
      this.tui = tui;
      return {
        render: () => this.renderWidget(tui, theme),
        invalidate: () => {
          this.widgetRegistered = false;
          this.tui = undefined;
        },
      };
    }, { placement: "aboveEditor" });
    this.widgetRegistered = true;
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.inputCtx = undefined;
    this.selection.end();
    this.viewingId = undefined;
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.uiCtx = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
