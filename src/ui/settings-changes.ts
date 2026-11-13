import type { SubagentsSettings } from "../config/settings.js";

export interface ParsedChange {
  key: keyof SubagentsSettings;
  value: unknown;
  message: string;
}

type Parser = (value: string) => ParsedChange | undefined;

function toggle(key: keyof SubagentsSettings, message: (enabled: boolean) => string): Parser {
  return (value) => ({ key, value: value === "on", message: message(value === "on") });
}

function choice(key: keyof SubagentsSettings, message: (value: string) => string): Parser {
  return (value) => ({ key, value, message: message(value) });
}

function integer(
  key: keyof SubagentsSettings,
  min: number,
  message: (n: number) => string,
): Parser {
  return (value) => {
    const n = parseInt(value, 10);
    return n >= min ? { key, value: n, message: message(n) } : undefined;
  };
}

const enabledWord = (enabled: boolean): string => (enabled ? "enabled" : "disabled");

const PARSERS: Record<string, Parser> = {
  maxConcurrent: integer("maxConcurrent", 1, (n) => `Max concurrency set to ${n}`),
  maxConcurrentForeground: integer("maxConcurrentForeground", 0, (n) =>
    n === 0 ? "Max foreground concurrency set to unlimited" : `Max foreground concurrency set to ${n}`,
  ),
  defaultMaxTurns: integer("defaultMaxTurns", 0, (n) =>
    n === 0 ? "Default max turns set to unlimited" : `Default max turns set to ${n}`,
  ),
  graceTurns: integer("graceTurns", 1, (n) => `Grace turns set to ${n}`),
  maxSubagentDepth: integer("maxSubagentDepth", 0, (n) =>
    n <= 1 ? "Nested delegation disabled" : `Nested depth set to ${n}. Applies to agents started from now on.`,
  ),
  joinMode: choice("defaultJoinMode", (v) => `Default join mode set to ${v}`),
  backgroundByDefault: toggle("backgroundByDefault", (enabled) =>
    enabled
      ? "agent calls run in the background unless they pass run_in_background: false"
      : "agent calls block and return inline unless they pass run_in_background: true",
  ),
  scopeModels: toggle("scopeModels", (enabled) => `Scope models ${enabledWord(enabled)}`),
  strictAgentFiles: toggle(
    "strictAgentFiles",
    (enabled) => `Strict agent files ${enabledWord(enabled)}. Takes effect on next pi session.`,
  ),
  outputTranscript: toggle("outputTranscript", (enabled) => `Output transcript ${enabledWord(enabled)} by default`),
  worktreeIsolation: toggle(
    "worktreeIsolation",
    (enabled) => `Worktree isolation ${enabledWord(enabled)}. Tool parameter updates on next pi session.`,
  ),
  toolDescriptionMode: choice(
    "toolDescriptionMode",
    (v) => `Tool description set to ${v}. Takes effect on next pi session.`,
  ),
  reportUsage: toggle("reportUsage", (enabled) =>
    enabled
      ? "Subagent usage now counted in this session's totals"
      : "Subagent usage no longer counted in this session's totals",
  ),
  showCost: toggle("showCost", (enabled) => `Cost display ${enabledWord(enabled)}`),
  showModel: toggle("showModel", (enabled) => `Model display ${enabledWord(enabled)}`),
  viewerMarkdown: choice("viewerMarkdown", (v) => `Viewer markdown set to ${v}`),
  fleetView: toggle("fleetView", (enabled) => `Fleet view ${enabledWord(enabled)}`),
  agentMentions: choice("agentMentions", (mode) =>
    mode === "off"
      ? "Agent mentions disabled"
      : mode === "model"
        ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
        : "Agent mentions on — a mentioned agent starts here, with no model call",
  ),
  rememberAgents: toggle("rememberAgents", (enabled) => `Remember agents ${enabledWord(enabled)}`),
  widgetMode: choice("widgetMode", (v) => `Widget set to ${v}`),
};

export function parseSettingChange(id: string, value: string): ParsedChange | undefined {
  return PARSERS[id]?.(value);
}
