import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { isScopeModelsEnabled } from "../config/model-scope.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents } from "../config/runner-defaults.js";
import type { RuntimeSettings, SettingsPersistence } from "../config/runtime-settings.js";
import { describeRange, SETTING_SPECS } from "../config/settings-defaults.js";
import type { AgentManager } from "../manager/agent-manager.js";
import { getOutputTranscriptDefault } from "../platform/output-file.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { getMaxSubagentDepth } from "../tool/nested-tools.js";
import { parseSettingChange } from "./settings-changes.js";
import { SETTING_ROWS } from "./settings-rows.js";

export interface SettingsMenuDeps {
  settings: Readonly<RuntimeSettings>;
  manager: Pick<AgentManager, "getMaxConcurrent" | "getMaxConcurrentForeground">;
  settingsPersist: Pick<SettingsPersistence, "notifyApplied">;
  isStrictAgentFiles: () => boolean;
}

const NUMERIC_SETTING_IDS = ["maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth"] as const;
type NumericSettingId = (typeof NUMERIC_SETTING_IDS)[number];

function isNumericSettingId(id: string | undefined): id is NumericSettingId {
  return (NUMERIC_SETTING_IDS as readonly string[]).includes(id as string);
}

const NUMERIC_PROMPT_LABELS: Record<NumericSettingId, string> = {
  maxConcurrent: "Max concurrency",
  maxConcurrentForeground: "Max foreground concurrency, 0 = unlimited",
  defaultMaxTurns: "Default max turns, 0 = unlimited",
  graceTurns: "Grace turns",
  maxSubagentDepth: "Nested depth, 0 or 1 = nesting off",
};

function promptLabel(id: NumericSettingId): string {
  return `${NUMERIC_PROMPT_LABELS[id]} (${describeRange(SETTING_SPECS[id])})`;
}

function readNumericSetting(id: NumericSettingId, manager: SettingsMenuDeps["manager"]): string {
  switch (id) {
    case "maxConcurrent": return String(manager.getMaxConcurrent());
    case "maxConcurrentForeground": return String(manager.getMaxConcurrentForeground());
    case "defaultMaxTurns": return String(getDefaultMaxTurns() ?? 0);
    case "graceTurns": return String(getGraceTurns());
    case "maxSubagentDepth": return String(getMaxSubagentDepth());
  }
}

const onOff = (enabled: boolean): string => (enabled ? "on" : "off");

function readSetting(id: string, deps: SettingsMenuDeps): string {
  const { settings, manager, isStrictAgentFiles } = deps;
  if (isNumericSettingId(id)) return readNumericSetting(id, manager);
  switch (id) {
    case "joinMode": return settings.defaultJoinMode;
    case "backgroundByDefault": return onOff(settings.backgroundByDefault);
    case "scopeModels": return onOff(isScopeModelsEnabled());
    case "strictAgentFiles": return onOff(isStrictAgentFiles());
    case "outputTranscript": return onOff(getOutputTranscriptDefault());
    case "worktreeIsolation": return onOff(isWorktreeIsolationEnabled());
    case "reportUsage": return onOff(settings.reportUsage);
    case "showCost": return onOff(settings.showCost);
    case "showModel": return onOff(settings.showModel);
    case "viewerMarkdown": return settings.viewerMarkdown;
    case "fleetView": return onOff(settings.fleetView);
    case "agentMentions": return settings.agentMentionMode;
    case "rememberAgents": return onOff(getRememberAgents());
    case "widgetMode": return settings.widgetMode;
    default: return settings.toolDescriptionMode;
  }
}

export function applySettingValue(ctx: ExtensionCommandContext, deps: SettingsMenuDeps, id: string, value: string): void {
  const parsed = parseSettingChange(id, value);
  if (!parsed) return;
  if (!parsed.ok) {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }
  deps.settingsPersist.notifyApplied(ctx, parsed.message, { layer: "project", key: parsed.key, value: parsed.value });
}

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
  const { manager } = deps;

  function buildItems(): SettingItem[] {
    return SETTING_ROWS.map((row) => {
      const currentValue = readSetting(row.id, deps);
      return {
        id: row.id,
        label: row.label,
        description: row.description,
        currentValue,
        values: row.values ? [...row.values] : [currentValue],
      };
    });
  }

  let list: SettingsList;
  let currentIndex = 0;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applySettingValue(ctx, deps, id, newValue);
      },
      () => done(undefined as undefined),
    );

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "up")) {
          currentIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(data, "down")) {
          currentIndex = Math.min(items.length - 1, currentIndex + 1);
        }

        if (matchesKey(data, Key.enter) && isNumericSettingId(items[currentIndex].id)) {
          done(items[currentIndex].id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  if (isNumericSettingId(result)) {
    const current = readNumericSetting(result, manager);
    const label = promptLabel(result);

    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const parsed = parseSettingChange(result, trimmed);
      if (parsed?.ok) {
        applySettingValue(ctx, deps, result, trimmed);
        await showSettings(ctx, deps);
        return;
      }
      if (parsed) ctx.ui.notify(parsed.message, "warning");
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
