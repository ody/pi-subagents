import { getConfig } from "../agents/agent-types.js";
import type { AgentInvocation, SubagentType } from "../types.js";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  activity?: string;
  spinnerFrame?: number;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number;
  cost?: number;
  agentId?: string;
  error?: string;
}

export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

export interface AgentLabelSource {
  type: SubagentType;
  displayName?: string;
  promptMode?: "replace" | "append";
}

export function getDisplayName(agent: SubagentType | AgentLabelSource): string {
  if (typeof agent === "string") return getConfig(agent).displayName;
  return agent.displayName ?? getConfig(agent.type).displayName;
}

export function getPromptModeLabel(agent: SubagentType | AgentLabelSource): string | undefined {
  const promptMode = typeof agent === "string" ? getConfig(agent).promptMode : (agent.promptMode ?? getConfig(agent.type).promptMode);
  return promptMode === "replace" ? "bare" : undefined;
}

export function renderModeTag(theme: Theme, label: string | undefined): string {
  return label ? ` ${theme.fg("warning", `(${label})`)}` : "";
}

export interface Stat {
  kind: "model" | "thinking" | "turns" | "tools" | "tokens" | "cost" | "time";
  text: string;
}

const STAT_COLORS: Record<Exclude<Stat["kind"], "thinking">, string> = {
  model: "mdLink",
  turns: "syntaxNumber",
  tools: "toolTitle",
  tokens: "mdCode",
  cost: "syntaxString",
  time: "muted",
};

function statColor(stat: Stat): string {
  if (stat.kind !== "thinking") return STAT_COLORS[stat.kind];
  const level = /^thinking: (\w+)/.exec(stat.text)?.[1] ?? "medium";
  return `thinking${level[0].toUpperCase()}${level.slice(1)}`;
}

export function renderStats(theme: Theme, stats: Stat[]): string {
  return stats.map(stat => fgPreservingNestedStyles(theme, statColor(stat), stat.text)).join(theme.fg("dim", " · "));
}

export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const overPinned = (value: string | undefined, pinned: string | undefined): string | undefined =>
    value && pinned && pinned !== value ? `${value} (over pinned ${pinned})` : value;
  const thinkingNotes = [
    invocation.requestedThinking && invocation.requestedThinking !== invocation.thinking
      ? `asked ${invocation.requestedThinking}`
      : undefined,
    invocation.pinnedThinking && invocation.pinnedThinking !== invocation.thinking
      ? `over ${invocation.pinnedThinking}`
      : undefined,
  ].filter(note => note !== undefined);
  if (invocation.thinking) {
    tags.push(`thinking: ${invocation.thinking}${thinkingNotes.length > 0 ? ` (${thinkingNotes.join(", ")})` : ""}`);
  }
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.pinnedRunInBackground !== undefined && invocation.pinnedRunInBackground !== !!invocation.runInBackground) {
    const mode = (background: boolean | undefined) => background ? "background" : "foreground";
    tags.push(`${mode(invocation.runInBackground)} (over ${mode(invocation.pinnedRunInBackground)})`);
  } else if (invocation.runInBackground) {
    tags.push("background");
  }
  if (invocation.pinnedMaxTurns !== undefined && (invocation.pinnedMaxTurns || undefined) !== invocation.maxTurns) {
    const pinned = invocation.pinnedMaxTurns === 0 ? "unlimited" : String(invocation.pinnedMaxTurns);
    tags.push(`${invocation.maxTurns == null ? "unlimited" : `${invocation.maxTurns} turns`} (over ${pinned})`);
  } else if (invocation.maxTurns != null) {
    tags.push(`max turns: ${invocation.maxTurns}`);
  }
  return {
    modelName: overPinned(invocation.modelName, invocation.pinnedModel),
    modelId: overPinned(invocation.modelId, invocation.pinnedModel),
    tags,
  };
}

function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}
