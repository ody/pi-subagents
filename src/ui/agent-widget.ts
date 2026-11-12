import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../manager/agent-manager.js";
import { isTopLevelAgent } from "../manager/agent-manager-rules.js";
import type { AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "../usage.js";
import { renderAgentName } from "./agent-color.js";
import {
  buildInvocationTags,
  describeActivity,
  ERROR_STATUSES,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatSessionTokens,
  formatTurns,
  getPromptModeLabel,
  SPINNER,
  type Theme,
} from "./agent-format.js";
import { layoutWidgetBody } from "./widget-layout.js";

const MAX_WIDGET_LINES = 12;

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

export function statusBarText(running: number, queued: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return `${parts.join(", ")} agent${running + queued === 1 ? "" : "s"}`;
}

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private finishedTurnAge = new Map<string, number>();
  private static readonly ERROR_LINGER_TURNS = 2;

  private widgetRegistered = false;
  private tui: any | undefined;
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private mode: () => WidgetMode = () => "all",
    private showCost: () => boolean = () => false,
    private showModel: () => boolean = () => false,
  ) {}

  private widgetAgents() {
    const all = this.manager.listAgents().filter(isTopLevelAgent);
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  private runningRows(tops: readonly AgentRecord[]): { record: AgentRecord; depth: number }[] {
    const byParent = new Map<string, AgentRecord[]>();
    for (const record of this.manager.listAgents()) {
      if (record.parentAgentId === undefined || record.status !== "running") continue;
      const bucket = byParent.get(record.parentAgentId);
      if (bucket) bucket.push(record);
      else byParent.set(record.parentAgentId, [record]);
    }
    for (const bucket of byParent.values()) bucket.sort((a, b) => a.startedAt - b.startedAt);

    const rows: { record: AgentRecord; depth: number }[] = [];
    const walk = (record: AgentRecord, depth: number): void => {
      rows.push({ record, depth });
      for (const child of byParent.get(record.id) ?? []) walk(child, depth + 1);
    };
    for (const top of tops) walk(top, 0);
    return rows;
  }

  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
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

  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
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

  private renderFinishedLine(a: { id: string; type: SubagentType; displayName?: string; promptMode?: "replace" | "append"; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number; error?: string; lifetimeUsage?: LifetimeUsage }, theme: Theme): string {
    const modeLabel = getPromptModeLabel(a);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.manager.getActivity(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    if (costText) parts.push(costText);
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    return `${icon} ${renderAgentName(a, theme, { fallbackColor: "dim" })}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.widgetAgents();
    const running = this.runningRows(allAgents.filter(a => a.status === "running"));
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines = running.map(({ record, depth }) => this.runningRowLines(record, depth, theme, frame).map(truncate) as [string, string]);

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];
    const { body, hidden } = layoutWidgetBody({ finished: finishedLines, running: runningLines, queued: queuedLine }, MAX_WIDGET_LINES - 1);
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

  private runningRowLines(a: AgentRecord, depth: number, theme: Theme, frame: string): [string, string] {
    const indent = "   ".repeat(depth);
    const modeLabel = getPromptModeLabel(a);
    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const elapsed = formatMs(Date.now() - a.startedAt);

    const bg = this.manager.getActivity(a.id);
    const toolUses = bg?.toolUses ?? a.toolUses;
    const tokens = getLifetimeTotal(a.lifetimeUsage);
    const contextPercent = getSessionContextPercent(bg?.session);
    const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

    const parts: string[] = [];
    if (this.showModel()) {
      const { modelName, tags } = buildInvocationTags(a.invocation);
      if (modelName) parts.push(modelName);
      const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
      if (thinkingTag) parts.push(thinkingTag);
    }
    if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
    if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
    if (tokenText) parts.push(tokenText);
    if (costText) parts.push(costText);
    parts.push(elapsed);
    const statsText = parts.join(" · ");

    const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

    return [
      theme.fg("dim", `${indent}├─`) + ` ${theme.fg("accent", frame)} ${renderAgentName(a, theme, { bold: true })}${modeTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`,
      theme.fg("dim", `${indent}│  `) + theme.fg("dim", `  ⎿  ${activity}`),
    ];
  }

  update() {
    if (!this.uiCtx) return;
    const allAgents = this.widgetAgents();

    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    if (!hasActive && !hasFinished) {
      this.clearWidget(allAgents);
      return;
    }

    const newStatusText = hasActive ? statusBarText(runningCount, queuedCount) : undefined;
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;
    this.registerWidget(this.uiCtx);
  }

  private clearWidget(allAgents: AgentRecord[]) {
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
      if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
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
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
