import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";
import {
  type SettingChange,
  type SettingsAppliers,
  type SettingsEmit,
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

export interface SettingsPersistence {
  persist(ctx: ExtensionCommandContext | undefined, changeMsg: string, change: SettingChange): void;
  notifyApplied(ctx: ExtensionCommandContext, successMsg: string, change: SettingChange): void;
}

export function createSettingsPersistence(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SettingsPersistence {
  return {
    persist(ctx, changeMsg, change) {
      const { message, level } = saveAndEmitChanged(change, changeMsg, emit, appliers, cwd);
      if (level === "warning") ctx?.ui.notify(message, level);
    },
    notifyApplied(ctx, successMsg, change) {
      const { message, level } = saveAndEmitChanged(change, successMsg, emit, appliers, cwd);
      ctx.ui.notify(message, level);
    },
  };
}
