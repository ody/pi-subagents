// Size: ConversationViewer is one overlay component; scrolling, the steering composer, and rendering share its scroll, focus, and live-session state.
import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../session/context.js";
import type { AgentActivity, AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { renderAgentName } from "./agent-color.js";
import type { Theme } from "./agent-format.js";
import { buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
export const VIEWPORT_HEIGHT_PCT = 70;

export const RESULT_MAX_CHARS = 16_000;

const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private keys: ViewerKeys;
  private composer: Input | undefined;
  private readonly markdownTheme: MarkdownTheme;
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: () => void,
    keybindings?: ViewerKeybindings,
    private onSteer?: (message: string) => void,
    private showCost = false,
    private viewerMarkdown?: () => ViewerMarkdownMode,
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.handleInput(data);
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

    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
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
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
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

  private headerLine(): string {
    const th = this.theme;
    const modeLabel = getPromptModeLabel(this.record);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    return `${statusIcon} ${renderAgentName(this.record, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`;
  }

  private composerFooter(innerW: number): string[] {
    const th = this.theme;
    const input = this.composer?.render(innerW)[0] ?? "";
    const composeHint = th.fg("dim", "Enter send · Esc cancel");
    const composeLeft = th.fg("accent", "✎ steer");
    const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
    return [input, composeLeft + " ".repeat(composeGap) + composeHint];
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
    actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
    const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

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
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  private markdownLines(msg: AgentSession["messages"][number], text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const filtered = this.record.filtered?.length ? [`policy removed ${this.record.filtered.join(", ")}`] : [];
    const parts = [...(model ? [model, ...tags] : tags), ...filtered];
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private messageLines(msg: AgentSession["messages"][number], mode: ViewerMarkdownMode, width: number): string[] | undefined {
    switch (msg.role) {
      case "user": return this.userLines(msg, width);
      case "assistant": return this.assistantLines(msg, mode, width);
      case "toolResult": return this.toolResultLines(msg, mode, width);
      default:
        return (msg as any).role === "bashExecution" ? this.bashLines(msg, width) : undefined;
    }
  }

  private userLines(msg: any, width: number): string[] | undefined {
    const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
    if (!text.trim()) return undefined;
    return [this.theme.fg("accent", "[User]"), ...wrapTextWithAnsi(text.trim(), width)];
  }

  private assistantLines(msg: any, mode: ViewerMarkdownMode, width: number): string[] {
    const th = this.theme;
    const textParts: string[] = [];
    const toolCalls: string[] = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "toolCall") {
        toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
      }
    }
    const lines = [th.bold("[Assistant]")];
    if (textParts.length > 0) {
      const text = textParts.join("\n").trim();
      lines.push(...(mode === "off"
        ? this.rawLines(text, width, false)
        : this.markdownLines(msg, text, width, false)));
    }
    for (const name of toolCalls) {
      lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
    }
    return lines;
  }

  private toolResultLines(msg: any, mode: ViewerMarkdownMode, width: number): string[] | undefined {
    const th = this.theme;
    const { text, elided } = capResult(extractText(msg.content).trim());
    if (!text) return undefined;
    const lines = [
      th.fg("dim", "[Result]"),
      ...(mode === "all" ? this.markdownLines(msg, text, width, true) : this.rawLines(text, width, true)),
    ];
    if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    return lines;
  }

  private bashLines(bash: any, width: number): string[] {
    const th = this.theme;
    const lines = [truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width)];
    if (bash.output?.trim()) {
      const { text, elided } = capResult(bash.output.trim());
      lines.push(...this.rawLines(text, width, true));
      if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    }
    return lines;
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    const mode = this.markdownMode();
    let needsSeparator = false;
    for (const msg of messages) {
      const body = this.messageLines(msg, mode, width);
      if (!body) continue;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(...body);
      needsSeparator = true;
    }

    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    return lines.map(l => truncateToWidth(l, width));
  }
}
