import type { NotificationDetails } from "../types.js";
import { formatCost, formatMs, formatTokens, formatTurns, type Theme } from "./agent-format.js";

export function notificationStats(d: NotificationDetails, showCost: boolean, theme: Theme): string {
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (showCost) {
    const costText = formatCost(d.totalCost ?? 0);
    if (costText) parts.push(costText);
  }
  if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
  return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
}

export function formatNotification(
  d: NotificationDetails,
  opts: { expanded: boolean; showCost: boolean },
  theme: Theme,
): string {
  const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const statusText = isError ? d.status
    : d.status === "steered" ? "completed (steered)"
    : "completed";

  let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

  const stats = notificationStats(d, opts.showCost, theme);
  if (stats) line += "\n  " + stats;

  if (opts.expanded) {
    const lines = d.resultPreview.split("\n").slice(0, 30);
    for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
  } else {
    const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
    line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
  }

  if (d.outputFile) {
    line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
  }

  return line;
}

export function formatBatchSummary(all: NotificationDetails[], theme: Theme): string | undefined {
  const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
  if (!total) return undefined;
  const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
  return theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`);
}
