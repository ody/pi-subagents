// Size: the menu's item list and the per-setting handler table both enumerate the same 20 settings, so they change together.

import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../config/model-scope.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "../config/runner-defaults.js";
import type { RuntimeSettings, SettingsPersistence } from "../config/runtime-settings.js";
import type { SettingsAppliers, ToolDescriptionMode } from "../config/settings.js";
import type { AgentManager } from "../manager/agent-manager.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../platform/output-file.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../platform/worktree.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../tool/nested-tools.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";

export interface SettingsMenuDeps {
  settings: Readonly<RuntimeSettings>;
  appliers: Pick<
    SettingsAppliers,
    | "setDefaultJoinMode"
    | "setBackgroundByDefault"
    | "setStrictAgentFiles"
    | "setToolDescriptionMode"
    | "setFleetView"
    | "setAgentMentions"
    | "setWidgetMode"
    | "setReportUsage"
    | "setShowCost"
    | "setShowModel"
    | "setViewerMarkdown"
  >;
  manager: Pick<AgentManager, "getMaxConcurrent" | "getMaxConcurrentForeground" | "setMaxConcurrent" | "setMaxConcurrentForeground">;
  settingsPersist: Pick<SettingsPersistence, "notifyApplied">;
  isStrictAgentFiles: () => boolean;
}

const NUMERIC_SETTING_IDS = ["maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth"] as const;
type NumericSettingId = (typeof NUMERIC_SETTING_IDS)[number];

function isNumericSettingId(id: string | undefined): id is NumericSettingId {
  return (NUMERIC_SETTING_IDS as readonly string[]).includes(id as string);
}

const NUMERIC_PROMPT_LABELS: Record<NumericSettingId, string> = {
  maxConcurrent: "Max concurrency (1+)",
  maxConcurrentForeground: "Max foreground concurrency (0 = unlimited)",
  defaultMaxTurns: "Default max turns (0 = unlimited)",
  graceTurns: "Grace turns (1+)",
  maxSubagentDepth: "Nested depth (0/1 = nesting off)",
};

function readNumericSetting(id: NumericSettingId, manager: SettingsMenuDeps["manager"]): string {
  switch (id) {
    case "maxConcurrent": return String(manager.getMaxConcurrent());
    case "maxConcurrentForeground": return String(manager.getMaxConcurrentForeground());
    case "defaultMaxTurns": return String(getDefaultMaxTurns() ?? 0);
    case "graceTurns": return String(getGraceTurns());
    case "maxSubagentDepth": return String(getMaxSubagentDepth());
  }
}

type SettingId =
  | "maxConcurrent" | "maxConcurrentForeground" | "defaultMaxTurns" | "graceTurns" | "maxSubagentDepth"
  | "joinMode" | "backgroundByDefault" | "scopeModels" | "strictAgentFiles"
  | "outputTranscript" | "worktreeIsolation"
  | "toolDescriptionMode" | "reportUsage" | "showCost" | "showModel" | "viewerMarkdown"
  | "fleetView" | "agentMentions" | "rememberAgents" | "widgetMode";

function settingHandlers(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Map<string, (value: string) => void> {
  const { appliers, manager, settingsPersist } = deps;
  const handlers: Record<SettingId, (value: string) => void> = {
    maxConcurrent: (value) => {
      const n = parseInt(value, 10);
      if (n >= 1) {
        manager.setMaxConcurrent(n);
        settingsPersist.notifyApplied(ctx, `Max concurrency set to ${n}`);
      }
    },
    maxConcurrentForeground: (value) => {
      const n = parseInt(value, 10);
      if (n >= 0) {
        manager.setMaxConcurrentForeground(n);
        settingsPersist.notifyApplied(ctx, n === 0
          ? "Max foreground concurrency set to unlimited"
          : `Max foreground concurrency set to ${n}`);
      }
    },
    defaultMaxTurns: (value) => {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        settingsPersist.notifyApplied(ctx, "Default max turns set to unlimited");
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        settingsPersist.notifyApplied(ctx, `Default max turns set to ${n}`);
      }
    },
    graceTurns: (value) => {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        settingsPersist.notifyApplied(ctx, `Grace turns set to ${n}`);
      }
    },
    maxSubagentDepth: (value) => {
      const n = parseInt(value, 10);
      if (n >= 0) {
        setMaxSubagentDepth(n);
        settingsPersist.notifyApplied(
          ctx,
          n <= 1
            ? "Nested delegation disabled"
            : `Nested depth set to ${n}. Applies to agents started from now on.`,
        );
      }
    },
    joinMode: (value) => {
      appliers.setDefaultJoinMode(value as JoinMode);
      settingsPersist.notifyApplied(ctx, `Default join mode set to ${value}`);
    },
    backgroundByDefault: (value) => {
      const enabled = value === "on";
      appliers.setBackgroundByDefault(enabled);
      settingsPersist.notifyApplied(
        ctx,
        enabled
          ? "agent calls run in the background unless they pass run_in_background: false"
          : "agent calls block and return inline unless they pass run_in_background: true",
      );
    },
    scopeModels: (value) => {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      settingsPersist.notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
    },
    strictAgentFiles: (value) => {
      const enabled = value === "on";
      appliers.setStrictAgentFiles(enabled);
      settingsPersist.notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
    },
    outputTranscript: (value) => {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      settingsPersist.notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
    },
    worktreeIsolation: (value) => {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      settingsPersist.notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
      );
    },
    toolDescriptionMode: (value) => {
      appliers.setToolDescriptionMode(value as ToolDescriptionMode);
      settingsPersist.notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
    },
    reportUsage: (value) => {
      const enabled = value === "on";
      appliers.setReportUsage(enabled);
      settingsPersist.notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
      );
    },
    showCost: (value) => {
      const enabled = value === "on";
      appliers.setShowCost(enabled);
      settingsPersist.notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
    },
    showModel: (value) => {
      const enabled = value === "on";
      appliers.setShowModel(enabled);
      settingsPersist.notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
    },
    viewerMarkdown: (value) => {
      appliers.setViewerMarkdown(value as ViewerMarkdownMode);
      settingsPersist.notifyApplied(ctx, `Viewer markdown set to ${value}`);
    },
    fleetView: (value) => {
      const enabled = value === "on";
      appliers.setFleetView(enabled);
      settingsPersist.notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
    },
    agentMentions: (value) => {
      const mode = value as AgentMentionMode;
      appliers.setAgentMentions(mode);
      settingsPersist.notifyApplied(
        ctx,
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
      );
    },
    rememberAgents: (value) => {
      const enabled = value === "on";
      setRememberAgents(enabled);
      settingsPersist.notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
    },
    widgetMode: (value) => {
      appliers.setWidgetMode(value as WidgetMode);
      settingsPersist.notifyApplied(ctx, `Widget set to ${value}`);
    },
  };
  return new Map(Object.entries(handlers));
}

export function applySettingValue(ctx: ExtensionCommandContext, deps: SettingsMenuDeps, id: string, value: string): void {
  settingHandlers(ctx, deps).get(id)?.(value);
}

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
  const { settings, manager, isStrictAgentFiles } = deps;

  function buildItems(): SettingItem[] {
    const mc = readNumericSetting("maxConcurrent", manager);
    const mcf = readNumericSetting("maxConcurrentForeground", manager);
    const dmt = readNumericSetting("defaultMaxTurns", manager);
    const gt = readNumericSetting("graceTurns", manager);
    const msd = readNumericSetting("maxSubagentDepth", manager);

    return [
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: mc,
        values: [mc],
      },
      {
        id: "maxConcurrentForeground",
        label: "Max foreground concurrency",
        description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
        currentValue: mcf,
        values: [mcf],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: dmt,
        values: [dmt],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: gt,
        values: [gt],
      },
      {
        id: "maxSubagentDepth",
        label: "Nested depth",
        description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
        currentValue: msd,
        values: [msd],
      },
      {
        id: "joinMode",
        label: "Join mode",
        description: "Default join mode for background agents",
        currentValue: settings.defaultJoinMode,
        values: ["smart", "async", "group"],
      },
      {
        id: "backgroundByDefault",
        label: "Background by default",
        description: "An agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
        currentValue: settings.backgroundByDefault ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "scopeModels",
        label: "Scope models",
        description: "Validate subagent models against scoped models (/scoped-models)",
        currentValue: isScopeModelsEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "strictAgentFiles",
        label: "Strict agent files",
        description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
        currentValue: isStrictAgentFiles() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "outputTranscript",
        label: "Output transcript",
        description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: getOutputTranscriptDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "worktreeIsolation",
        label: "Worktree isolation",
        description:
          "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the agent tool spec on next pi session.",
        currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "reportUsage",
        label: "Report usage to session",
        description:
          "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
        currentValue: settings.reportUsage ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showCost",
        label: "Show cost",
        description:
          "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
        currentValue: settings.showCost ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showModel",
        label: "Show model",
        description:
          "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
        currentValue: settings.showModel ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "viewerMarkdown",
        label: "Viewer markdown",
        description:
          "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
        currentValue: settings.viewerMarkdown,
        values: ["off", "assistant", "all"],
      },
      {
        id: "fleetView",
        label: "Fleet view",
        description: "Navigable main+subagents tree below the editor (↓/← to navigate, Enter to view)",
        currentValue: settings.fleetView ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "agentMentions",
        label: "Agent mentions",
        description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
        currentValue: settings.agentMentionMode,
        values: ["model", "direct", "off"],
      },
      {
        id: "rememberAgents",
        label: "Remember agents",
        description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
        currentValue: getRememberAgents() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "widgetMode",
        label: "Widget",
        description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
        currentValue: settings.widgetMode,
        values: ["all", "background", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description: "agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
        currentValue: settings.toolDescriptionMode,
        values: ["full", "compact", "custom"],
      },
    ];
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
    const label = NUMERIC_PROMPT_LABELS[result];

    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applySettingValue(ctx, deps, result, String(n));
        await showSettings(ctx, deps);
        return;
      }
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
