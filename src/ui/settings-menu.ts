import { existsSync } from "node:fs";
import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { layerEphemeralNesting } from "../config/capability-policy-config.js";
import type { SettingsPersistence } from "../config/runtime-settings.js";
import { layerValues, readLayerSettings } from "../config/settings.js";
import { describeRange, SETTING_SPECS } from "../config/settings-defaults.js";
import { layerPath, readLayerFile, type SettingsLayer } from "../config/settings-store.js";
import { parseSettingChange } from "./settings-changes.js";
import { buildItems, displayValue, type RowId, type RowSource, type RowValues, rowSources, SETTING_ROWS } from "./settings-rows.js";

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

function layerOwn(layer: SettingsLayer, cwd: string): Partial<Record<RowId, unknown>> {
  const read = readLayerSettings(layer, cwd);
  const own = read.ok ? read.own : {};
  return layerEphemeralNesting(layer, cwd) === undefined ? own : { ...own, ephemeralNesting: true };
}

function projectSources(cwd: string): Record<string, RowSource> {
  return rowSources(layerOwn("project", cwd), layerOwn("global", cwd));
}

function rowValues(layer: SettingsLayer, cwd: string): RowValues {
  const global = layerEphemeralNesting("global", cwd) !== false;
  const project = layerEphemeralNesting("project", cwd) !== false;
  return { ...layerValues(layer, cwd), ephemeralNesting: layer === "global" ? global : global && project };
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
  if (layer === "project" && parsed.key === "ephemeralNesting" && parsed.value === true && layerEphemeralNesting("global", deps.cwd) === false) {
    ctx.ui.notify("Ephemeral nesting is off in the global file, and a project can only narrow it. Turn it on in the global layer first.", "warning");
    return;
  }
  const message = `${parsed.message}${overrideNotice(layer, parsed.key, parsed.value, deps.cwd)}`;
  deps.settingsPersist.notifyApplied(ctx, message, { layer, key: parsed.key, value: parsed.value });
}

function projectOverrides(key: string, value: unknown, cwd: string): boolean {
  if (key === "ephemeralNesting") return layerEphemeralNesting("project", cwd) === false && value !== false;
  const project = readLayerSettings("project", cwd);
  return project.ok && key in project.own;
}

function overrideNotice(layer: SettingsLayer, key: string, value: unknown, cwd: string): string {
  const overridden = layer === "global" && projectOverrides(key, value, cwd);
  return overridden ? ". This project overrides it, so the change does not reach this project." : "";
}

export function resetSettingValue(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  layer: SettingsLayer,
  id: RowId,
): boolean {
  const file = readLayerFile(layer, deps.cwd);
  if (!file.ok || !fileSetsRow(file.data, id)) return false;
  const label = SETTING_ROWS.find((row) => row.id === id)?.label ?? id;
  const outcome = layer === "project" ? "now inherits" : "is back to the default";
  const message = `${label} ${outcome}${overrideNotice(layer, id, undefined, deps.cwd)}`;
  deps.settingsPersist.notifyApplied(ctx, message, { layer, key: id, value: undefined });
  return true;
}

function fileSetsRow(data: Record<string, unknown>, id: RowId): boolean {
  if (id !== "ephemeralNesting") return id in data;
  const policy = data.policy;
  return typeof policy === "object" && policy !== null && id in policy;
}

function currentText(values: RowValues, id: NumericSettingId): string {
  return displayValue(values[id]);
}

interface MenuOutcome {
  result: string | undefined;
  selected: string;
  values: RowValues;
}

function isEditKey(data: string): boolean {
  return data === "r" || data === " " || matchesKey(data, Key.enter) || matchesKey(data, "left") || matchesKey(data, "right");
}

function movedIndex(data: string, index: number, count: number): number {
  if (matchesKey(data, "up")) return (index + count - 1) % count;
  if (matchesKey(data, "down")) return (index + 1) % count;
  return index;
}

interface MenuKeyContext {
  ctx: ExtensionCommandContext;
  deps: SettingsMenuDeps;
  layer: SettingsLayer;
  rowIds: readonly RowId[];
  nav: { index: number };
  readOnlyReason: string | undefined;
  list: SettingsList;
  done: (result: string | undefined) => void;
}

function handleMenuKey(data: string, menu: MenuKeyContext): void {
  const { ctx, deps, layer, rowIds, nav, readOnlyReason, list, done } = menu;
  if (matchesKey(data, Key.tab)) {
    done(SWITCH_LAYER);
    return;
  }
  nav.index = movedIndex(data, nav.index, rowIds.length);
  if (readOnlyReason && isEditKey(data)) {
    ctx.ui.notify(`${readOnlyReason}. Fix the file first.`, "warning");
    return;
  }
  const row = rowIds[nav.index];
  if (data === "r") {
    if (resetSettingValue(ctx, deps, layer, row)) done(REFRESH);
    return;
  }
  if (matchesKey(data, Key.enter) && isNumericSettingId(row)) {
    done(row);
    return;
  }
  list.handleInput?.(data);
}

async function runMenu(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  layer: SettingsLayer,
  selectedRow: string | undefined,
): Promise<MenuOutcome> {
  const values = rowValues(layer, deps.cwd);
  const file = readLayerSettings(layer, deps.cwd);
  const readOnlyReason = file.ok ? undefined : file.reason;
  const rowIds = SETTING_ROWS.map((row) => row.id);
  const nav = { index: Math.max(0, rowIds.findIndex((id) => id === selectedRow)) };
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
    list.selectItem(rowIds[nav.index]);

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
      handleInput: (data: string) => handleMenuKey(data, { ctx, deps, layer, rowIds, nav, readOnlyReason, list, done }),
    };
  });

  return { result, selected: rowIds[nav.index], values };
}

export async function showSettings(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  state: SettingsMenuState = {},
): Promise<void> {
  let layer = state.layer ?? initialLayer(deps.cwd);
  let selected = state.selected;
  for (;;) {
    const outcome = await runMenu(ctx, deps, layer, selected);
    selected = outcome.selected;
    if (outcome.result === SWITCH_LAYER) {
      layer = otherLayer(layer);
      continue;
    }
    if (outcome.result === REFRESH) continue;
    if (!isNumericSettingId(outcome.result)) return;
    if (!(await editNumeric(ctx, deps, layer, outcome.result, outcome.values))) return;
    selected = outcome.result;
  }
}

async function editNumeric(
  ctx: ExtensionCommandContext,
  deps: SettingsMenuDeps,
  layer: SettingsLayer,
  id: NumericSettingId,
  values: RowValues,
): Promise<boolean> {
  const label = promptLabel(id);
  let input: string | undefined = await ctx.ui.input(label, currentText(values, id));
  while (input != null) {
    const trimmed = input.trim();
    const parsed = parseSettingChange(id, trimmed);
    if (parsed?.ok) {
      applySettingValue(ctx, deps, layer, id, trimmed);
      return true;
    }
    if (parsed) ctx.ui.notify(parsed.message, "warning");
    input = await ctx.ui.input(label, trimmed);
  }
  return false;
}
