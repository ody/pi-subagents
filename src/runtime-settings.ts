// In-memory runtime settings state and its persistence (settings shape: what
// `/agents -> Settings` toggles and what every settings write puts on disk).
//
// One mutable object, passed by reference. Consumers hold a narrow
// `Readonly<Pick<RuntimeSettings, ...>>` and read fields live; only `index.ts`
// writes, through the appliers object it builds.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents } from "./runner-defaults.js";
import { getFallbackSubagent, isDefaultsDisabled } from "./agent-types.js";
import { isScopeModelsEnabled } from "./model-scope.js";
import { getMaxSubagentDepth } from "./nested-tools.js";
import { getOutputTranscriptDefault } from "./output-file.js";
import {
  type SettingsEmit,
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "./settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "./types.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/** The settings held in memory, as opposed to the ones living in their own modules. */
export interface RuntimeSettings {
  /** Attach subagent spend to tool results, so the parent session counts it. */
  reportUsage: boolean;
  /** Show `~$X` next to token counts in the subagent surfaces. */
  showCost: boolean;
  /** Name the model and thinking level on the widget's running rows. */
  showModel: boolean;
  /** How much of the conversation viewer renders as Markdown. */
  viewerMarkdown: ViewerMarkdownMode;
  /** What the widget list shows. */
  widgetMode: WidgetMode;
  /** Whether the fleet view renders. */
  fleetView: boolean;
  /** Claude Code-style `@handle message` prompt mentions. */
  agentMentionMode: AgentMentionMode;
  /** Project/global default for the spawn join mode. */
  defaultJoinMode: JoinMode;
  /** What an unqualified top-level spawn means; `false` restores foreground. */
  backgroundByDefault: boolean;
  /** Master switch for the schedule subagent feature. */
  schedulingEnabled: boolean;
  /** Agent tool description flavor: "full", "compact" or a custom file. */
  toolDescriptionMode: ToolDescriptionMode;
  /** Whether custom agent files must parse strictly. */
  strictAgentFiles: boolean;
}

/** What `snapshotSettings` reads beyond the in-memory state. */
export interface SnapshotSources {
  manager: Pick<AgentManager, "getMaxConcurrent" | "getMaxConcurrentForeground">;
}

/**
 * Every settings mutation writes this WHOLE object back to disk, so a field
 * missing here is erased from the user's subagents.json the next time they
 * toggle something unrelated. `SubagentsSettings` has every field optional,
 * so a `: SubagentsSettings` return annotation would let a newly-added setting
 * be forgotten here and still type-check. `satisfies` instead: it still checks
 * each value's type and rejects a mistyped key, but leaves the return type
 * inferred so `_NoMissingSettingsKeys` below can check completeness.
 */
export function snapshotSettings(settings: Readonly<RuntimeSettings>, src: SnapshotSources) {
  return {
    maxConcurrent: src.manager.getMaxConcurrent(),
    // 0 = unlimited, and the default — see SubagentsSettings.
    maxConcurrentForeground: src.manager.getMaxConcurrentForeground(),
    // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
    // normalizeMaxTurns() in runner-defaults (which maps 0 → undefined).
    defaultMaxTurns: getDefaultMaxTurns() ?? 0,
    graceTurns: getGraceTurns(),
    defaultJoinMode: settings.defaultJoinMode,
    backgroundByDefault: settings.backgroundByDefault,
    schedulingEnabled: settings.schedulingEnabled,
    scopeModels: isScopeModelsEnabled(),
    strictAgentFiles: settings.strictAgentFiles,
    disableDefaultAgents: isDefaultsDisabled(),
    toolDescriptionMode: settings.toolDescriptionMode,
    fleetView: settings.fleetView,
    agentMentions: settings.agentMentionMode,
    rememberAgents: getRememberAgents(),
    widgetMode: settings.widgetMode,
    outputTranscript: getOutputTranscriptDefault(),
    worktreeIsolation: isWorktreeIsolationEnabled(),
    maxSubagentDepth: getMaxSubagentDepth(),
    // Deliberately NOT `?? "general-purpose"`: every settings change writes the
    // whole snapshot, and materializing the implicit default would turn it into
    // explicit configuration — which then fails loudly if general-purpose later
    // goes away. undefined is dropped by JSON.stringify.
    fallbackSubagent: getFallbackSubagent(),
    reportUsage: settings.reportUsage,
    showCost: settings.showCost,
    showModel: settings.showModel,
    viewerMarkdown: settings.viewerMarkdown,
  } satisfies SubagentsSettings;
}

// Compile-time completeness guard for snapshotSettings(). If a field is added
// to SubagentsSettings and not mirrored above, this Exclude is non-empty and
// fails to satisfy `never` — turning a silent settings-erasure bug into a
// typecheck error. `npm run typecheck` runs in CI.
type _NoMissingSettingsKeys =
  Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
    ? true
    : ["snapshotSettings() is missing a SubagentsSettings key"];
const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
void _settingsSnapshotIsComplete;

export interface SettingsPersistence {
  /**
   * Persist + broadcast the settings, silent on success — for a change whose
   * feedback is the UI it just changed: the viewer's `m` key, where a
   * notification per press would talk over the overlay it is describing.
   *
   * A *failed* write still speaks. Every other settings path warns when the
   * value is session-only, and swallowing it here would leave a preference
   * looking persisted when the next session will not have it.
   */
  persist(ctx: ExtensionCommandContext | undefined, changeMsg: string): void;
  /** Persist + broadcast + toast, for a change made from the settings menu. */
  notifyApplied(ctx: ExtensionCommandContext, successMsg: string): void;
}

/** The two settings-write paths, bound to one snapshot source and one emit. */
export function createSettingsPersistence(
  settings: Readonly<RuntimeSettings>,
  src: SnapshotSources,
  emit: SettingsEmit,
): SettingsPersistence {
  return {
    persist(ctx, changeMsg) {
      const { message, level } = saveAndEmitChanged(snapshotSettings(settings, src), changeMsg, emit);
      // `ctx` is absent only on the fleet path between sessions, where
      // `currentCtx` has been cleared and there is no UI to carry the warning
      // to. The write still happens.
      if (level === "warning") ctx?.ui.notify(message, level);
    },
    notifyApplied(ctx, successMsg) {
      const { message, level } = saveAndEmitChanged(snapshotSettings(settings, src), successMsg, emit);
      ctx.ui.notify(message, level);
    },
  };
}
