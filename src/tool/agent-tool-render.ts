import type { AgentToolResult, Theme as PiTheme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../ui/agent-color.js";
import {
  type AgentDetails,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatTurns,
  SPINNER,
  type Theme,
} from "../ui/agent-format.js";

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

export function renderAgentCall(
  args: { subagent_type: string; description?: string },
  theme: PiTheme,
  context: { isPartial: boolean; isError: boolean },
): Text {
  const rowBackground = hasAgentBadge(args.subagent_type)
    ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
    : "";
  const desc = args.description ?? "";
  const name = renderAgentName(args.subagent_type, theme, {
    fallbackColor: "toolTitle",
    restoreBackground: rowBackground,
    bold: true,
  });
  return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
}

function formatAgentStats(d: AgentDetails, theme: PiTheme, showCost: boolean): string {
  const parts: string[] = [];
  if (d.modelName) parts.push(d.modelName);
  if (d.tags) parts.push(...d.tags);
  if (d.turnCount != null && d.turnCount > 0) {
    parts.push(formatTurns(d.turnCount, d.maxTurns));
  }
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.tokens) parts.push(d.tokens);
  if (showCost) {
    const costText = formatCost(d.cost ?? 0);
    if (costText) parts.push(costText);
  }
  return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
}

function appendExpandedOutput(line: string, resultText: string, theme: PiTheme): string {
  if (!resultText) return line;
  const all = resultText.split("\n");
  for (const l of all.slice(0, 50)) {
    line += "\n" + theme.fg("dim", `  ${l}`);
  }
  if (all.length > 50) {
    line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
  }
  return line;
}

function renderFinishedAgent(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  theme: PiTheme,
  stats: string,
): Text {
  const isSteered = details.status === "steered";
  const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
  let line = icon + (stats ? " " + stats : "");
  line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", formatMs(details.durationMs));

  if (expanded) {
    line = appendExpandedOutput(line, resultText, theme);
  } else {
    const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
    line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
  }
  return new Text(line, 0, 0);
}

function renderFailedAgent(details: AgentDetails, theme: PiTheme, stats: string): Text {
  let line = theme.fg("error", "✗") + (stats ? " " + stats : "");
  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }
  return new Text(line, 0, 0);
}

export function renderAgentResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: PiTheme,
  renderContext: { isError: boolean },
  showCost: boolean,
): Container | Text {
  const details = result.details as AgentDetails | undefined;
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (renderContext.isError || !details?.status) {
    return new Text(text, 0, 0);
  }

  const stats = formatAgentStats(details, theme, showCost);

  if (isPartial || details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0];
    return renderRunningAgentStatus(frame, stats, details.activity ?? "thinking…", theme);
  }

  if (details.status === "background") {
    return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
  }

  if (details.status === "completed" || details.status === "steered") {
    return renderFinishedAgent(details, text, expanded, theme, stats);
  }

  if (details.status === "stopped") {
    let line = theme.fg("dim", "■") + (stats ? " " + stats : "");
    line += "\n" + theme.fg("dim", "  ⎿  Stopped");
    return new Text(line, 0, 0);
  }

  if (details.status !== "error" && details.status !== "aborted") {
    return new Text(text, 0, 0);
  }

  return renderFailedAgent(details, theme, stats);
}
