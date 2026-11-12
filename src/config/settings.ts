// Size: the SubagentsSettings interface documents every field (about half the file); sanitize, load/save and apply all change together whenever a setting is added.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";
import { policyEventPayload, readProjectPolicyRaw } from "./capability-policy-config.js";
import { globalSettingsPath, projectSettingsPath } from "./settings-paths.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  maxConcurrentForeground?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  backgroundByDefault?: boolean;
  schedulingEnabled?: boolean;
  scopeModels?: boolean;
  strictAgentFiles?: boolean;
  toolDescriptionMode?: ToolDescriptionMode;
  fleetView?: boolean;
  agentMentions?: AgentMentionMode;
  rememberAgents?: boolean;
  widgetMode?: WidgetMode;
  outputTranscript?: boolean;
  worktreeIsolation?: boolean;
  maxSubagentDepth?: number;
  reportUsage?: boolean;
  showCost?: boolean;

  showModel?: boolean;
  viewerMarkdown?: ViewerMarkdownMode;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setMaxConcurrentForeground: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setBackgroundByDefault: (b: boolean) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
  setShowModel: (b: boolean) => void;
  setViewerMarkdown: (mode: ViewerMarkdownMode) => void;
}

export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_VIEWER_MARKDOWN_MODES: ReadonlySet<string> = new Set<ViewerMarkdownMode>(["off", "assistant", "all"]);
const VALID_AGENT_MENTION_MODES: ReadonlySet<string> = new Set<AgentMentionMode>(["model", "direct", "off"]);

const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat per-field allowlist, one independent check per setting, no nesting
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.maxConcurrentForeground) &&
    (r.maxConcurrentForeground as number) >= 0 &&
    (r.maxConcurrentForeground as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrentForeground = r.maxConcurrentForeground as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (
    Number.isInteger(r.maxSubagentDepth) &&
    (r.maxSubagentDepth as number) >= 0 &&
    (r.maxSubagentDepth as number) <= SUBAGENT_DEPTH_CEILING
  ) {
    out.maxSubagentDepth = r.maxSubagentDepth as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.backgroundByDefault === "boolean") {
    out.backgroundByDefault = r.backgroundByDefault;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.strictAgentFiles === "boolean") {
    out.strictAgentFiles = r.strictAgentFiles;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.fleetView === "boolean") {
    out.fleetView = r.fleetView;
  }
  if (typeof r.agentMentions === "boolean") {
    out.agentMentions = r.agentMentions ? "model" : "off";
  } else if (typeof r.agentMentions === "string" && VALID_AGENT_MENTION_MODES.has(r.agentMentions)) {
    out.agentMentions = r.agentMentions as AgentMentionMode;
  }
  if (typeof r.rememberAgents === "boolean") {
    out.rememberAgents = r.rememberAgents;
  }
  if (typeof r.widgetMode === "string" && VALID_WIDGET_MODES.has(r.widgetMode)) {
    out.widgetMode = r.widgetMode as WidgetMode;
  }
  if (typeof r.outputTranscript === "boolean") {
    out.outputTranscript = r.outputTranscript;
  }
  if (typeof r.worktreeIsolation === "boolean") {
    out.worktreeIsolation = r.worktreeIsolation;
  }
  if (typeof r.reportUsage === "boolean") {
    out.reportUsage = r.reportUsage;
  }
  if (typeof r.showCost === "boolean") {
    out.showCost = r.showCost;
  }
  if (typeof r.showModel === "boolean") {
    out.showModel = r.showModel;
  }
  if (typeof r.viewerMarkdown === "string" && VALID_VIEWER_MARKDOWN_MODES.has(r.viewerMarkdown)) {
    out.viewerMarkdown = r.viewerMarkdown as ViewerMarkdownMode;
  }
  return out;
}

function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalSettingsPath()), ...readSettingsFile(projectSettingsPath(cwd)) };
}

export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectSettingsPath(cwd);
  const existing = readProjectPolicyRaw(cwd);
  if (!existing.ok) {
    console.warn(`[pi-subagents] Not saving settings: ${existing.reason}. Fix the file so its policy is not lost.`);
    return false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = existing.policy === undefined ? s : { ...s, policy: existing.policy };
    writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.maxConcurrentForeground === "number") {
    appliers.setMaxConcurrentForeground(s.maxConcurrentForeground);
  }
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (typeof s.maxSubagentDepth === "number") appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.backgroundByDefault === "boolean") appliers.setBackgroundByDefault(s.backgroundByDefault);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.strictAgentFiles === "boolean") appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (typeof s.rememberAgents === "boolean") appliers.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
  if (typeof s.outputTranscript === "boolean") appliers.setOutputTranscript(s.outputTranscript);
  if (typeof s.worktreeIsolation === "boolean") appliers.setWorktreeIsolation(s.worktreeIsolation);
  if (typeof s.reportUsage === "boolean") appliers.setReportUsage(s.reportUsage);
  if (typeof s.showCost === "boolean") appliers.setShowCost(s.showCost);
  if (typeof s.showModel === "boolean") appliers.setShowModel(s.showModel);
  if (s.viewerMarkdown) appliers.setViewerMarkdown(s.viewerMarkdown);
}

export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  const policy = policyEventPayload(cwd);
  for (const problem of policy.malformed ?? []) console.warn(`[pi-subagents] Capability policy: ${problem}. Every spawn is denied until it is fixed.`);
  emit("subagents:settings_loaded", { settings, policy });
  return settings;
}

export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted, policy: policyEventPayload(cwd) });
  return persistToastFor(successMsg, persisted);
}
