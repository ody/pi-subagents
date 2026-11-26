import type { AgentActivity, AgentRecord, AgentTombstone } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { renderAgentName, renderAgentNameLabel } from "./agent-color.js";
import {
  buildInvocationTags,
  describeActivity,
  formatAge,
  formatCost,
  formatMs,
  formatSessionTokens,
  formatTurns,
  getPromptModeLabel,
  renderModeTag,
  renderStats,
  renderStatusIcon,
  type Stat,
  statusPresentation,
  type Theme,
} from "./agent-format.js";

export interface RowLineDeps {
  getActivity: (id: string) => AgentActivity | undefined;
  showCost: boolean;
  showModel: boolean;
}

function connector(theme: Theme, selected: boolean): string {
  return selected ? theme.fg("accent", "▸ ") : theme.fg("dim", "├─");
}

function finishedStatusText(a: AgentRecord, theme: Theme): string {
  const { color, note } = statusPresentation(a.status);
  if (a.status === "completed") return "";
  if (a.status === "error") return theme.fg(color, ` error${a.error ? `: ${a.error.slice(0, 60)}` : ""}`);
  return theme.fg(color, note ? ` (${note})` : ` ${a.status}`);
}

export function finishedRowLine(a: AgentRecord, depth: number, selected: boolean, theme: Theme, deps: RowLineDeps): string {
  const modeLabel = getPromptModeLabel(a);
  const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);
  const icon = renderStatusIcon(theme, a.status);
  const statusText = finishedStatusText(a, theme);

  const parts: Stat[] = [];
  const activity = deps.getActivity(a.id);
  if (activity) parts.push({ kind: "turns", text: formatTurns(activity.turnCount, activity.maxTurns) });
  if (a.toolUses > 0) parts.push({ kind: "tools", text: `${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}` });
  const costText = deps.showCost ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
  if (costText) parts.push({ kind: "cost", text: costText });
  parts.push({ kind: "time", text: duration });

  const indent = "   ".repeat(depth);
  return `${indent}${connector(theme, selected)} ${icon} ${renderAgentName(a, theme, { fallbackColor: "dim" })}${renderModeTag(theme, modeLabel)}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${renderStats(theme, parts)}${statusText}`;
}

export function historyRowLine(entry: AgentTombstone, selected: boolean, theme: Theme): string {
  const name = entry.alias ?? entry.handle;
  const stats = renderStats(theme, [{ kind: "time", text: formatAge(entry.completedAt) }]);
  return `${connector(theme, selected)} ${renderStatusIcon(theme, entry.status)} ${renderAgentNameLabel(name, entry.agentConfig?.color, theme, { fallbackColor: "dim" })}  ${theme.fg("muted", entry.description)} ${theme.fg("dim", "·")} ${theme.fg("muted", entry.agentConfig?.displayName ?? entry.type)} ${theme.fg("dim", "·")} ${stats}`;
}

export function runningRowLines(
  a: AgentRecord,
  depth: number,
  selected: boolean,
  theme: Theme,
  frame: string,
  deps: RowLineDeps,
): [string, string] {
  const indent = "   ".repeat(depth);
  const modeLabel = getPromptModeLabel(a);
  const elapsed = formatMs(Date.now() - a.startedAt);

  const bg = deps.getActivity(a.id);
  const toolUses = bg?.toolUses ?? a.toolUses;
  const tokens = getLifetimeTotal(a.lifetimeUsage);
  const contextPercent = getSessionContextPercent(bg?.session);
  const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";
  const costText = deps.showCost ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

  const parts: Stat[] = [];
  if (deps.showModel) {
    const { modelName, tags } = buildInvocationTags(a.invocation);
    if (modelName) parts.push({ kind: "model", text: modelName });
    const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
    if (thinkingTag) parts.push({ kind: "thinking", text: thinkingTag });
  }
  if (bg) parts.push({ kind: "turns", text: formatTurns(bg.turnCount, bg.maxTurns) });
  if (toolUses > 0) parts.push({ kind: "tools", text: `${toolUses} tool use${toolUses === 1 ? "" : "s"}` });
  if (tokenText) parts.push({ kind: "tokens", text: tokenText });
  if (costText) parts.push({ kind: "cost", text: costText });
  parts.push({ kind: "time", text: elapsed });
  const statsText = renderStats(theme, parts);

  const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

  return [
    `${indent}${connector(theme, selected)} ${renderStatusIcon(theme, a.status, frame)} ${renderAgentName(a, theme, { bold: true })}${renderModeTag(theme, modeLabel)}  ${theme.fg("text", a.description)} ${theme.fg("dim", "·")} ${statsText}`,
    theme.fg("dim", `${indent}│  `) + theme.fg("dim", `  ⎿  ${activity}`),
  ];
}
