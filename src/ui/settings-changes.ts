import type { SubagentsSettings } from "../config/settings.js";
import { describeRange, isValidSettingValue, SETTING_SPECS } from "../config/settings-defaults.js";

export type ParsedChange =
  | { ok: true; key: keyof SubagentsSettings; value: unknown; message: string }
  | { ok: false; message: string };

type Parser = (value: string) => ParsedChange;

function toggle(key: keyof SubagentsSettings, message: (enabled: boolean) => string): Parser {
  return (value) => ({ ok: true, key, value: value === "on", message: message(value === "on") });
}

function choice(key: keyof SubagentsSettings, message: (value: string) => string): Parser {
  return (value) => ({ ok: true, key, value, message: message(value) });
}

function integer(key: keyof SubagentsSettings, message: (n: number) => string): Parser {
  const spec = SETTING_SPECS[key];
  return (value) => {
    const n = Number(value.trim());
    if (value.trim() === "" || !isValidSettingValue(spec, n)) {
      return { ok: false, message: `${key} must be a whole number from ${describeRange(spec)}` };
    }
    return { ok: true, key, value: n, message: message(n) };
  };
}

const enabledWord = (enabled: boolean): string => (enabled ? "enabled" : "disabled");

const PARSERS: Record<string, Parser> = {
  maxConcurrent: integer("maxConcurrent", (n) => `Max concurrency set to ${n}`),
  maxConcurrentForeground: integer("maxConcurrentForeground", (n) =>
    n === 0 ? "Max foreground concurrency set to unlimited" : `Max foreground concurrency set to ${n}`,
  ),
  defaultMaxTurns: integer("defaultMaxTurns", (n) =>
    n === 0 ? "Default max turns set to unlimited" : `Default max turns set to ${n}`,
  ),
  graceTurns: integer("graceTurns", (n) => `Grace turns set to ${n}`),
  maxSubagentDepth: integer("maxSubagentDepth", (n) =>
    n <= 1 ? "Nested delegation disabled" : `Nested depth set to ${n}. Applies to agents started from now on.`,
  ),
  defaultJoinMode: choice("defaultJoinMode", (v) => `Default join mode set to ${v}`),
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
  return Object.hasOwn(PARSERS, id) ? PARSERS[id](value) : undefined;
}
