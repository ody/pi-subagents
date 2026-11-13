import { existsSync } from "node:fs";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { SettingsPersistence } from "../config/runtime-settings.js";
import { layerValues, readLayerSettings, type SubagentsSettings } from "../config/settings.js";
import { describeRange, SETTING_SPECS } from "../config/settings-defaults.js";
import { layerPath, readLayerFile, type SettingsLayer } from "../config/settings-store.js";
import { parseSettingChange } from "./settings-changes.js";
import { buildItems, displayValue, type RowSource, rowSources, SETTING_ROWS } from "./settings-rows.js";

export interface SettingsMenuDeps {
  cwd: string;
  settingsPersist: Pick<SettingsPersistence, "notifyApplied">;
}

export interface SettingsMenuState {
  layer?: SettingsLayer;
  selected?: string;
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

const SWITCH_LAYER = "\0tab";
const REFRESH = "\0refresh";

function projectSources(cwd: string): Record<string, RowSource> {
  const project = readLayerSettings("project", cwd);
  const global = readLayerSettings("global", cwd);
  return rowSources(project.ok ? project.own : {}, global.ok ? global.own : {});
}

const otherLayer = (layer: SettingsLayer): SettingsLayer => (layer === "global" ? "project" : "global");

export function initialLayer(cwd: string): SettingsLayer {
  return existsSync(layerPath("project", cwd)) ? "project" : "global";
}

export function applySettingValue(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  layer: SettingsLayer,
  id: string,
  value: string,
): void {
  const parsed = parseSettingChange(id, value);
  if (!parsed) return;
  if (!parsed.ok) {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }
  const message = `${parsed.message}${overrideNotice(layer, parsed.key, deps.cwd)}`;
  deps.settingsPersist.notifyApplied(ctx, message, { layer, key: parsed.key, value: parsed.value });
}

function overrideNotice(layer: SettingsLayer, key: string, cwd: string): string {
  const project = readLayerSettings("project", cwd);
  const overridden = layer === "global" && project.ok && key in project.own;
  return overridden ? ". This project overrides it, so the change does not reach this project." : "";
}

export function resetSettingValue(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  layer: SettingsLayer,
  id: keyof SubagentsSettings,
): boolean {
  const file = readLayerFile(layer, deps.cwd);
  if (!file.ok || !(id in file.data)) return false;
  const label = SETTING_ROWS.find((row) => row.id === id)?.label ?? id;
  const outcome = layer === "project" ? "now inherits" : "is back to the default";
  const message = `${label} ${outcome}${overrideNotice(layer, id, deps.cwd)}`;
  deps.settingsPersist.notifyApplied(ctx, message, { layer, key: id, value: undefined });
  return true;
}

function currentText(values: Required<SubagentsSettings>, id: NumericSettingId): string {
  return displayValue(values[id]);
}

export async function showSettings(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  state: SettingsMenuState = {},
): Promise<void> {
  const layer = state.layer ?? initialLayer(deps.cwd);
  const values = layerValues(layer, deps.cwd);
  const file = readLayerSettings(layer, deps.cwd);
  const readOnlyReason = file.ok ? undefined : file.reason;
  const rowIds = SETTING_ROWS.map((row) => row.id);
  let currentIndex = Math.max(0, rowIds.findIndex((id) => id === state.selected));
  const sources = layer === "project" ? projectSources(deps.cwd) : undefined;

  const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SettingsList(
      buildItems(values, sources, (text) => theme.fg("dim", text)),
      rowIds.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applySettingValue(ctx, deps, layer, id, newValue);
        if (layer === "project") done(REFRESH);
      },
      () => done(undefined as undefined),
    );
    list.selectItem(rowIds[currentIndex]);

    const scope = (name: SettingsLayer): string =>
      name === layer ? theme.fg("accent", theme.bold(name)) : theme.fg("dim", name);

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Text(`Scope: ${scope("global")} | ${scope("project")}`, 0, 0));
    if (readOnlyReason) container.addChild(new Text(theme.fg("error", `${readOnlyReason}. Read-only until the file is fixed.`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "tab scope · r reset"), 0, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.tab)) {
          done(SWITCH_LAYER);
          return;
        }
        if (matchesKey(data, "up")) {
          currentIndex = (currentIndex + rowIds.length - 1) % rowIds.length;
        } else if (matchesKey(data, "down")) {
          currentIndex = (currentIndex + 1) % rowIds.length;
        }

        const editing = data === "r" || matchesKey(data, Key.enter) || data === " " || matchesKey(data, "left") || matchesKey(data, "right");
        if (editing && readOnlyReason) {
          ctx.ui.notify(`${readOnlyReason}. Fix the file first.`, "warning");
          return;
        }
        if (data === "r") {
          if (resetSettingValue(ctx, deps, layer, rowIds[currentIndex])) done(REFRESH);
          return;
        }
        if (matchesKey(data, Key.enter) && isNumericSettingId(rowIds[currentIndex])) {
          done(rowIds[currentIndex]);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  const selected = rowIds[currentIndex];
  if (result === SWITCH_LAYER) {
    await showSettings(ctx, deps, { layer: otherLayer(layer), selected });
    return;
  }
  if (result === REFRESH) {
    await showSettings(ctx, deps, { layer, selected });
    return;
  }
  if (!isNumericSettingId(result)) return;

  const label = promptLabel(result);
  let input: string | undefined = await ctx.ui.input(label, currentText(values, result));
  while (input != null) {
    const trimmed = input.trim();
    const parsed = parseSettingChange(result, trimmed);
    if (parsed?.ok) {
      applySettingValue(ctx, deps, layer, result, trimmed);
      await showSettings(ctx, deps, { layer, selected: result });
      return;
    }
    if (parsed) ctx.ui.notify(parsed.message, "warning");
    input = await ctx.ui.input(label, trimmed);
  }
}
