import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import { formatCost, type Theme } from "./agent-format.js";
import { type AgentTreeNode, agentKey, ancestorKeys, buildAgentTree, MAIN_KEY, resolveSelectedKey } from "./agent-tree.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

const FLEET_KEY = "fleet";
const MAX_AGENT_ROWS = 5;
const TICK_MS = 200;
const FINISHED_LINGER_MS = 4000;

export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type FleetNode = AgentTreeNode;

export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  private active = false;
  private selectedKey: string = MAIN_KEY;
  private collapsedKeys = new Set<string>();
  private showGlyphs = false;
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private showCost: () => boolean = () => false,
    private viewerMarkdown?: () => ViewerMarkdownMode,
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    this.ui = undefined;
  }

  update(): void {
    if (!this.ui) return;
    const hasRows = this.enabled && this.nodes().length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedKey = MAIN_KEY;
      return;
    }

    this.reconcileSelection();
    this.ensureTimer();

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private isEligible(record: AgentRecord, now: number): boolean {
    if (!record.session) return false;
    return record.status === "running" || record.status === "queued"
      || record.id === this.viewingAgentId
      || (record.completedAt != null && now - record.completedAt < FINISHED_LINGER_MS);
  }

  private nodes(): FleetNode[] {
    const now = Date.now();
    return buildAgentTree({
      records: this.manager.listAgents(),
      isEligible: record => this.isEligible(record, now),
      collapsed: this.collapsedKeys,
    });
  }

  private reconcileSelection(): void {
    const nodes = this.nodes();
    this.selectedKey = resolveSelectedKey(nodes, this.selectedKey, ancestorKeys(nodes, this.selectedKey)) ?? MAIN_KEY;
  }

  private selectedNode(nodes: readonly FleetNode[]): FleetNode | undefined {
    return nodes.find(n => n.key === this.selectedKey);
  }

  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    if (isKeyRelease(data)) return undefined;
    if (this.viewerClose) return undefined;
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) return this.tryActivate(data) ? { consume: true } : undefined;

    if (matchesKey(data, "down")) this.moveSelection(true);
    else if (matchesKey(data, "up")) this.moveSelection(false);
    else if (matchesKey(data, "right")) this.expandSelected();
    else if (matchesKey(data, "left")) this.collapseOrAscend();
    else if (matchesKey(data, "escape")) this.deactivate();
    else if (matchesKey(data, Key.enter)) this.openSelected();
    else {
      this.deactivate();
      return undefined;
    }
    return { consume: true };
  }

  private tryActivate(data: string): boolean {
    const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
    if (!isActivator || this.nodes().length <= 1 || this.ui?.getEditorText() !== "") return false;
    this.active = true;
    this.selectedKey = MAIN_KEY;
    this.update();
    return true;
  }

  private moveSelection(down: boolean): void {
    const nodes = this.nodes();
    const index = nodes.findIndex(n => n.key === this.selectedKey);
    if (!down && index <= 0) {
      this.deactivate();
      return;
    }
    const target = nodes[down ? Math.min(nodes.length - 1, index + 1) : index - 1];
    if (target) this.selectedKey = target.key;
    this.update();
  }

  private expandSelected(): void {
    const node = this.selectedNode(this.nodes());
    if (node?.hasChildren && node.collapsed) {
      this.collapsedKeys.delete(node.key);
      this.update();
    }
  }

  private collapseOrAscend(): void {
    const node = this.selectedNode(this.nodes());
    if (node?.hasChildren && !node.collapsed) this.collapsedKeys.add(node.key);
    else if (node?.parentKey !== undefined) this.selectedKey = node.parentKey;
    this.update();
  }

  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedKey = MAIN_KEY;
    this.update();
  }

  private openSelected(): void {
    const entry = this.selectedNode(this.nodes());
    if (!entry || entry.kind === "main") {
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.manager.getActivity(record.id);
    this.viewingAgentId = record.id;

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  private clearViewer(): void {
    if (this.viewingAgentId !== undefined) this.selectedKey = agentKey(this.viewingAgentId);
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  private renderBar(width: number, theme: Theme): string[] {
    const nodes = this.nodes();
    const main = nodes[0]?.kind === "main" ? nodes[0] : undefined;
    const rows = main ? nodes.slice(1) : nodes;
    if (rows.length === 0) return [];

    const selected = this.selectedKey;
    const canCollapse = rows.some(row => row.hasChildren);
    this.showGlyphs = canCollapse || rows.some(row => row.kind === "agent" && row.orphan);
    const hint = this.active
      ? canCollapse ? "↑↓ select · ←→ collapse · enter view · esc back" : "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    if (main) lines.push(truncateToWidth(`${this.gutter(main, selected, theme)}main`, width));

    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, rows.findIndex(row => row.key === selected));
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      if (!row) continue;
      lines.push(
        row.kind === "agent" ? this.renderAgentRow(row, selected, width, theme)
        : truncateToWidth(`${this.gutter(row, selected, theme)}main`, width),
      );
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  private gutter(node: FleetNode, selected: string, theme: Theme): string {
    const glyph =
      node.kind === "agent" && node.orphan ? "↯"
      : node.hasChildren ? (node.collapsed ? "▸" : "▾")
      : " ";
    const column = this.showGlyphs ? theme.fg("dim", glyph) : "";
    return `  ${"  ".repeat(node.depth)}${column}${this.bullet(node.key, selected, theme)} `;
  }

  private bullet(key: string, selected: string, theme: Theme): string {
    return key === selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private renderAgentRow(node: FleetNode & { kind: "agent" }, selectedKey: string, width: number, theme: Theme): string {
    const record = node.record;
    const selected = node.key === selectedKey;
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? theme.fg("text", record.description) : record.description;
    const left = `${this.gutter(node, selectedKey, theme)}${name}  ${description}`;
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
