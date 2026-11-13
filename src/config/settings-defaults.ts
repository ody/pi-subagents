import type { SubagentsSettings } from "./settings.js";

export type SettingSpec =
  | { kind: "boolean"; default: boolean }
  | { kind: "integer"; default: number; min: number; max: number }
  | { kind: "enum"; default: string; values: readonly string[] };

type SpecFor<T> = [T] extends [boolean]
  ? { kind: "boolean"; default: T }
  : [T] extends [number]
    ? { kind: "integer"; default: T; min: number; max: number }
    : { kind: "enum"; default: T; values: readonly T[] };

type SettingSpecs = { [K in keyof SubagentsSettings]-?: SpecFor<NonNullable<SubagentsSettings[K]>> };

export const SETTING_SPECS: SettingSpecs = {
  maxConcurrent: { kind: "integer", default: 10, min: 1, max: 1024 },
  maxConcurrentForeground: { kind: "integer", default: 0, min: 0, max: 1024 },
  defaultMaxTurns: { kind: "integer", default: 0, min: 0, max: 10_000 },
  graceTurns: { kind: "integer", default: 5, min: 1, max: 1_000 },
  maxSubagentDepth: { kind: "integer", default: 2, min: 0, max: 16 },
  defaultJoinMode: { kind: "enum", default: "smart", values: ["smart", "async", "group"] },
  backgroundByDefault: { kind: "boolean", default: true },
  scopeModels: { kind: "boolean", default: false },
  strictAgentFiles: { kind: "boolean", default: false },
  outputTranscript: { kind: "boolean", default: true },
  worktreeIsolation: { kind: "boolean", default: true },
  reportUsage: { kind: "boolean", default: false },
  showCost: { kind: "boolean", default: false },
  showModel: { kind: "boolean", default: false },
  viewerMarkdown: { kind: "enum", default: "assistant", values: ["off", "assistant", "all"] },
  fleetView: { kind: "boolean", default: true },
  agentMentions: { kind: "enum", default: "model", values: ["model", "direct", "off"] },
  rememberAgents: { kind: "boolean", default: true },
  widgetMode: { kind: "enum", default: "all", values: ["all", "background", "off"] },
  toolDescriptionMode: { kind: "enum", default: "full", values: ["full", "compact", "custom"] },
};

export const SETTING_KEYS = Object.keys(SETTING_SPECS) as (keyof SubagentsSettings)[];

export function describeRange(spec: SettingSpec): string {
  if (spec.kind === "integer") return `${spec.min} to ${spec.max}`;
  if (spec.kind === "enum") return spec.values.join(", ");
  return "on or off";
}

export function isValidSettingValue(spec: SettingSpec, value: unknown): boolean {
  if (spec.kind === "boolean") return typeof value === "boolean";
  if (spec.kind === "integer") {
    return Number.isInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max;
  }
  return typeof value === "string" && spec.values.includes(value);
}
