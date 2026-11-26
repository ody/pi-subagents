import { type AgentSession, CustomEditor, getSelectListTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentActivity, AgentRecord, AgentTombstone } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { renderAgentName, renderAgentNameLabel } from "./agent-color.js";
import type { AgentStatus, Theme } from "./agent-format.js";
import { buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel, renderModeTag, renderStatusIcon, statusPresentation } from "./agent-format.js";
import type { MainSessionStatus } from "./main-session-status.js";
import { createViewerKeys, type ViewerKeys } from "./viewer-keys.js";
import { PendingSteers } from "./viewer-steers.js";
import { liveTranscriptSource, type StoredTranscript, storedTranscriptSource, ViewerTranscript } from "./viewer-transcript.js";

const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
export const VIEWPORT_WIDTH_PCT = 95;
export const VIEWPORT_HEIGHT_PCT = 90;

export interface LiveViewerTarget {
  kind: "live";
  session: AgentSession;
  record: AgentRecord;
  activity?: AgentActivity;
  onStop?: () => void;
  onSteer?: (message: string) => void;
}

export interface HistoryViewerTarget {
  kind: "history";
  entry: AgentTombstone;
  transcript: StoredTranscript;
}

export type ViewerTarget = LiveViewerTarget | HistoryViewerTarget;

function isActive(status: AgentStatus): boolean {
  return status === "running" || status === "queued";
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeMain: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private keys: ViewerKeys;
  private composer: CustomEditor | undefined;
  private readonly transcript: ViewerTranscript;
  private readonly steers: PendingSteers | undefined;

  constructor(
    private tui: TUI,
    private target: ViewerTarget,
    private theme: Theme,
    private done: (result: undefined) => void,
    private keybindings?: KeybindingsManager,
    private showCost = false,
    private mainSession?: MainSessionStatus,
  ) {
    this.transcript = new ViewerTranscript(
      tui,
      target.kind === "live" ? liveTranscriptSource(target.session) : storedTranscriptSource(target.transcript),
    );
    this.keys = createViewerKeys(keybindings);
    if (target.kind === "live") {
      const steers = new PendingSteers(target.session);
      this.steers = steers;
      this.unsubscribe = target.session.subscribe(() => {
        if (this.closed) return;
        steers.refresh();
        this.tui.requestRender();
      });
    }
    this.unsubscribeMain = mainSession?.subscribe(() => {
      if (!this.closed) this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.composer) {
      if (matchesKey(data, "escape")) this.composer = undefined;
      else this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    if (this.target.kind === "live" && matchesKey(data, "x")) {
      this.pressStop();
      return;
    }

    if (this.stopArmed) this.stopArmed = false;

    if (this.keys.expand(data)) {
      this.transcript.toggleExpanded();
      this.tui.requestRender();
      return;
    }

    this.scrollForKey(data);
  }

  private pressStop(): void {
    if (!this.isStoppable()) return;
    if (this.stopArmed) {
      this.stopArmed = false;
      if (this.target.kind === "live") this.target.onStop?.();
    } else {
      this.stopArmed = true;
    }
    this.tui.requestRender();
  }

  private scrollTarget(data: string, maxScroll: number, viewportHeight: number): number | undefined {
    if (this.keys.scrollUp(data)) return Math.max(0, this.scrollOffset - 1);
    if (this.keys.scrollDown(data)) return Math.min(maxScroll, this.scrollOffset + 1);
    if (this.keys.pageUp(data)) return Math.max(0, this.scrollOffset - viewportHeight);
    if (this.keys.pageDown(data)) return Math.min(maxScroll, this.scrollOffset + viewportHeight);
    if (matchesKey(data, "home")) return 0;
    if (matchesKey(data, "end")) return maxScroll;
    return undefined;
  }

  private scrollForKey(data: string): void {
    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    const target = this.scrollTarget(data, maxScroll, viewportHeight);
    if (target === undefined) return;
    this.scrollOffset = target;
    this.autoScroll = this.scrollOffset >= maxScroll;
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = this.topBorder(width);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    lines.push(row(this.headerLine()));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    lines.push(hrMid);
    const footer = this.composer
      ? this.composerFooter(innerW)
      : this.idleFooter(innerW, { lineCount: contentLines.length, viewportHeight, visibleStart });
    for (const content of footer) lines.push(row(content));
    lines.push(hrBot);

    return lines;
  }

  private topBorder(width: number): string {
    const th = this.theme;
    const status = this.mainSessionLine();
    const room = width - 6;
    if (!status || room < 1) return th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const fitted = truncateToWidth(status, room, "…");
    const fill = Math.max(1, width - 5 - visibleWidth(fitted));
    return th.fg("border", "╭─ ") + fitted + th.fg("border", ` ${"─".repeat(fill)}╮`);
  }

  private mainSessionLine(): string | undefined {
    const main = this.mainSession;
    if (!main) return undefined;
    const th = this.theme;
    const label = main.isRunning ? th.fg("accent", "● main working") : th.fg("dim", "○ main idle");
    const last = main.lastMessageLine;
    return last ? `${label}${th.fg("dim", " · ")}${th.fg("muted", last)}` : label;
  }

  private headerLine(): string {
    const target = this.target;
    return target.kind === "live" ? this.liveHeaderLine(target) : this.historyHeaderLine(target.entry);
  }

  private liveHeaderLine(target: LiveViewerTarget): string {
    const { record, activity } = target;
    const th = this.theme;
    const modeLabel = getPromptModeLabel(record);
    const modeTag = renderModeTag(th, modeLabel);
    const statusIcon = renderStatusIcon(th, record.status);
    const duration = formatDuration(record.startedAt, record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = activity?.toolUses ?? record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    return `${statusIcon} ${renderAgentName(record, th, { bold: true })}${modeTag}  ${th.fg("muted", record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`;
  }

  private historyHeaderLine(entry: AgentTombstone): string {
    const th = this.theme;
    const name = renderAgentNameLabel(entry.alias ?? entry.handle, entry.agentConfig?.color, th, { bold: true });
    const modeTag = renderModeTag(th, entry.agentConfig?.promptMode === "replace" ? "bare" : undefined);

    const statusParts: string[] = [];
    const { color, note } = statusPresentation(entry.status);
    if (entry.stopCause) statusParts.push(th.fg("dim", `stopped by ${entry.stopCause}`));
    else if (entry.status === "error") statusParts.push(th.fg(color, "error"));
    else if (entry.status !== "completed") statusParts.push(th.fg(color, note ? `${entry.status} (${note})` : entry.status));

    const tail = [th.fg("muted", entry.agentConfig?.displayName ?? entry.type), ...statusParts].join(th.fg("dim", " · "));
    return `${renderStatusIcon(th, entry.status)} ${name}${modeTag}  ${th.fg("muted", entry.description)} ${th.fg("dim", "·")} ${tail}`;
  }

  private composerFooter(innerW: number): string[] {
    const th = this.theme;
    const input = this.composer?.render(innerW) ?? [];
    const composeHint = th.fg("dim", "Enter send · Esc cancel");
    const composeLeft = th.fg("accent", "✎ steer");
    const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
    return [...input, composeLeft + " ".repeat(composeGap) + composeHint];
  }

  private idleFooter(
    innerW: number,
    scroll: { lineCount: number; viewportHeight: number; visibleStart: number },
  ): string[] {
    const th = this.theme;
    const sep = th.fg("dim", " · ");
    const actions: string[] = [];
    if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
    if (this.isStoppable()) {
      actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
    }
    if (!this.autoScroll) actions.push(th.fg("warning", "follow off · End to follow"));
    const { keys } = this;
    const footerRight = th.fg(
      "dim",
      `${keys.label("tui.select.up")}/${keys.label("tui.select.down")} scroll · ${keys.label("tui.select.pageUp")}/${keys.label("tui.select.pageDown")} page · ${keys.label("app.tools.expand")} expand · Esc close`,
    );

    const scrollPct = scroll.lineCount <= scroll.viewportHeight
      ? "100%"
      : `${Math.round(((scroll.visibleStart + scroll.viewportHeight) / scroll.lineCount) * 100)}%`;
    const count = th.fg("dim", `${scroll.lineCount} lines · ${scrollPct}`);
    const withCount = [count, ...actions].join(sep);
    const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
      ? withCount
      : actions.join(sep);

    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    return [footerLeft + " ".repeat(footerGap) + footerRight];
  }

  private isStoppable(): boolean {
    return this.target.kind === "live" && Boolean(this.target.onStop) && isActive(this.target.record.status);
  }

  private canSteer(): boolean {
    return this.target.kind === "live"
      && Boolean(this.target.onSteer)
      && Boolean(this.keybindings)
      && isActive(this.target.record.status);
  }

  private openComposer(): void {
    if (this.target.kind !== "live" || !this.keybindings) return;
    const { onSteer } = this.target;
    const steers = this.steers;
    if (!steers) return;
    const editor = new CustomEditor(
      this.tui,
      { borderColor: (text) => this.theme.fg("borderMuted", text), selectList: getSelectListTheme() },
      this.keybindings,
    );
    editor.focused = true;
    editor.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) {
        steers.add(message);
        onSteer?.(message);
      }
      this.tui.requestRender();
    };
    this.composer = editor;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.transcript.invalidate();
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.unsubscribeMain?.();
    this.unsubscribeMain = undefined;
  }

  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    const composerLines = this.composer ? this.composer.render(Math.max(1, this.lastInnerW)).length : 0;
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + composerLines;
  }

  private invocationLine(): string | undefined {
    if (this.target.kind !== "live") return undefined;
    const { invocation, filtered } = this.target.record;
    const { modelName, modelId, tags } = buildInvocationTags(invocation);
    const model = modelId ?? modelName;
    const policy = filtered?.length ? [`policy removed ${filtered.join(", ")}`] : [];
    const parts = [...(model ? [model, ...tags] : tags), ...policy];
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const lines = this.transcript.render(width);

    if (lines.length === 0) {
      lines.push(th.fg("dim", this.target.kind === "history" ? "(no messages)" : "(waiting for first message...)"));
    } else if (this.target.kind === "live" && this.target.record.status === "running" && this.target.activity) {
      const act = describeActivity(this.target.activity.activeTools, this.target.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    const steers = this.steers;
    if (!steers) return lines.map(l => truncateToWidth(l, width));
    if (!this.canSteer()) steers.clear();
    steers.refresh();
    for (const text of steers.texts()) lines.push(th.fg("dim", `Steering: ${text.replace(/\s*\n\s*/g, " ")}`));

    return lines.map(l => truncateToWidth(l, width));
  }
}
