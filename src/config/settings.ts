import { existsSync, readFileSync } from "node:fs";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";
import { policyEventPayload } from "./capability-policy-config.js";
import { isValidSettingValue, SETTING_KEYS, SETTING_SPECS } from "./settings-defaults.js";
import { globalSettingsPath, projectSettingsPath } from "./settings-paths.js";
import { readLayerFile, type SettingsLayer, setLayerKey } from "./settings-store.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  maxConcurrentForeground?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  backgroundByDefault?: boolean;
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

export function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (isValidSettingValue(SETTING_SPECS[key], r[key])) out[key] = r[key];
  }
  return out as SubagentsSettings;
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

function defaultSettings(): Required<SubagentsSettings> {
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTING_SPECS[key].default])) as Required<SubagentsSettings>;
}

export function effectiveSettings(cwd: string = process.cwd()): Required<SubagentsSettings> {
  return { ...defaultSettings(), ...loadSettings(cwd) };
}

export type LayerSettings =
  | { ok: true; exists: boolean; own: SubagentsSettings }
  | { ok: false; reason: string };

export function readLayerSettings(layer: SettingsLayer, cwd: string): LayerSettings {
  const read = readLayerFile(layer, cwd);
  return read.ok ? { ok: true, exists: read.exists, own: sanitize(read.data) } : read;
}

export function layerValues(layer: SettingsLayer, cwd: string): Required<SubagentsSettings> {
  if (layer === "project") return effectiveSettings(cwd);
  const global = readLayerSettings("global", cwd);
  return { ...defaultSettings(), ...(global.ok ? global.own : {}) };
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

export interface SettingChange {
  layer: SettingsLayer;
  key: keyof SubagentsSettings;
  value: unknown;
}

export function saveAndEmitChanged(
  change: SettingChange,
  successMsg: string,
  emit: SettingsEmit,
  appliers: SettingsAppliers,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = setLayerKey(change.layer, cwd, change.key, change.value).ok;
  const effective = effectiveSettings(cwd);
  const settings = persisted ? effective : { ...effective, ...sanitize({ [change.key]: change.value }) };
  applySettings(settings, appliers);
  emit("subagents:settings_changed", { settings, persisted, policy: policyEventPayload(cwd) });
  return persistToastFor(successMsg, persisted);
}
