import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../manager/agent-manager.js";
import { getOutputTranscriptDefault } from "../platform/output-file.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { getMaxSubagentDepth } from "../tool/nested-tools.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";
import { isScopeModelsEnabled } from "./model-scope.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents } from "./runner-defaults.js";
import {
  type SettingsEmit,
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "./settings.js";

export interface RuntimeSettings {
  reportUsage: boolean;
  showCost: boolean;
  showModel: boolean;
  viewerMarkdown: ViewerMarkdownMode;
  widgetMode: WidgetMode;
  fleetView: boolean;
  agentMentionMode: AgentMentionMode;
  defaultJoinMode: JoinMode;
  backgroundByDefault: boolean;
  toolDescriptionMode: ToolDescriptionMode;
  strictAgentFiles: boolean;
}

export interface SnapshotSources {
  manager: Pick<AgentManager, "getMaxConcurrent" | "getMaxConcurrentForeground">;
}

export function snapshotSettings(settings: Readonly<RuntimeSettings>, src: SnapshotSources) {
  return {
    maxConcurrent: src.manager.getMaxConcurrent(),
    maxConcurrentForeground: src.manager.getMaxConcurrentForeground(),
    defaultMaxTurns: getDefaultMaxTurns() ?? 0,
    graceTurns: getGraceTurns(),
    defaultJoinMode: settings.defaultJoinMode,
    backgroundByDefault: settings.backgroundByDefault,
    scopeModels: isScopeModelsEnabled(),
    strictAgentFiles: settings.strictAgentFiles,
    toolDescriptionMode: settings.toolDescriptionMode,
    fleetView: settings.fleetView,
    agentMentions: settings.agentMentionMode,
    rememberAgents: getRememberAgents(),
    widgetMode: settings.widgetMode,
    outputTranscript: getOutputTranscriptDefault(),
    worktreeIsolation: isWorktreeIsolationEnabled(),
    maxSubagentDepth: getMaxSubagentDepth(),
    reportUsage: settings.reportUsage,
    showCost: settings.showCost,
    showModel: settings.showModel,
    viewerMarkdown: settings.viewerMarkdown,
  } satisfies SubagentsSettings;
}

type _NoMissingSettingsKeys =
  Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
    ? true
    : ["snapshotSettings() is missing a SubagentsSettings key"];
const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
void _settingsSnapshotIsComplete;

export interface SettingsPersistence {
  persist(ctx: ExtensionCommandContext | undefined, changeMsg: string): void;
  notifyApplied(ctx: ExtensionCommandContext, successMsg: string): void;
}

export function createSettingsPersistence(
  settings: Readonly<RuntimeSettings>,
  src: SnapshotSources,
  emit: SettingsEmit,
): SettingsPersistence {
  return {
    persist(ctx, changeMsg) {
      const { message, level } = saveAndEmitChanged(snapshotSettings(settings, src), changeMsg, emit);
      if (level === "warning") ctx?.ui.notify(message, level);
    },
    notifyApplied(ctx, successMsg) {
      const { message, level } = saveAndEmitChanged(snapshotSettings(settings, src), successMsg, emit);
      ctx.ui.notify(message, level);
    },
  };
}
