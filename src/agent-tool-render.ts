import type { AgentToolResult, Theme as PiTheme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import {
  type AgentDetails,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatTurns,
  SPINNER,
  type Theme,
} from "./ui/agent-format.js";

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
  // A badge closes its own background, which would clear the tool block's row tint
  // for the rest of the line, so the badge restores it. The tint is opened here too:
  // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
  // background the line never opened is what banded the export before. The line is
  // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
  // wraps, so closing here would leave that padding untinted, and HTML export closes
  // any open span per line anyway. No badge means no tint, so an uncolored agent
  // renders exactly the line it always did.
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

/** `showCost` is read by the caller at render time so the cost setting stays live. */
export function renderAgentResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: PiTheme,
  renderContext: { isError: boolean },
  showCost: boolean,
): Container | Text {
  const details = result.details as AgentDetails | undefined;
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  // Pi reports pre-execution failures (extension block, abort, argument
  // validation) as `{ content: [reason], details: {} }` with isError set —
  // no status to render, so show the reason instead of inventing one (#199).
  if (renderContext.isError || !details?.status) {
    return new Text(text, 0, 0);
  }

  // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
  const stats = (d: AgentDetails) => {
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
  };

  // ---- While running (streaming) ----
  if (isPartial || details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0];
    const s = stats(details);
    return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
  }

  // ---- Background agent launched ----
  if (details.status === "background") {
    return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
  }

  // ---- Completed / Steered ----
  if (details.status === "completed" || details.status === "steered") {
    const duration = formatMs(details.durationMs);
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    const s = stats(details);
    let line = icon + (s ? " " + s : "");
    line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

    if (expanded) {
      const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (resultText) {
        const lines = resultText.split("\n").slice(0, 50);
        for (const l of lines) {
          line += "\n" + theme.fg("dim", `  ${l}`);
        }
        if (resultText.split("\n").length > 50) {
          line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
        }
      }
    } else {
      const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
      line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
    }
    return new Text(line, 0, 0);
  }

  // ---- Stopped (user-initiated abort) ----
  if (details.status === "stopped") {
    const s = stats(details);
    let line = theme.fg("dim", "■") + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", "  ⎿  Stopped");
    return new Text(line, 0, 0);
  }

  // Anything left ("queued", or a status added later) has no rendering of
  // its own — the turn-limit wording below must not be the catch-all.
  if (details.status !== "error" && details.status !== "aborted") {
    return new Text(text, 0, 0);
  }

  // ---- Error / Aborted (hard max_turns) ----
  const s = stats(details);
  let line = theme.fg("error", "✗") + (s ? " " + s : "");

  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }

  return new Text(line, 0, 0);
}
