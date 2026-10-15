// The `/agents -> Settings` menu: a SettingsList over every setting, plus the
// typed-input flow for numeric fields.

import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getAvailableTypes, getFallbackSubagent, isDefaultsDisabled, NO_FALLBACK, setFallbackSubagent } from "../agent-types.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../nested-tools.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../output-file.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "../runner-defaults.js";
import type { RuntimeSettings, SettingsPersistence } from "../runtime-settings.js";
import type { SubagentScheduler } from "../schedule.js";
import type { SettingsAppliers, ToolDescriptionMode } from "../settings.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "../types.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../worktree.js";

export interface SettingsMenuDeps {
  /** Live view of the in-memory settings; writes go through `appliers`. */
  settings: Readonly<RuntimeSettings>;
  /** Only the settings that live in `RuntimeSettings`; the rest are set through their own modules. */
  appliers: Pick<
    SettingsAppliers,
    | "setDefaultJoinMode"
    | "setBackgroundByDefault"
    | "setSchedulingEnabled"
    | "setStrictAgentFiles"
    | "setDisableDefaultAgents"
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
  scheduler: Pick<SubagentScheduler, "stop">;
  settingsPersist: Pick<SettingsPersistence, "notifyApplied">;
  /** The live strict-agent-files flag, which `settings.strictAgentFiles` does not track. */
  isStrictAgentFiles: () => boolean;
}

const NUMERIC_IDS = new Set([
  "maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth",
]);

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
  const { settings, appliers, manager, scheduler, settingsPersist, isStrictAgentFiles } = deps;

  function buildItems(): SettingItem[] {
    const mc = manager.getMaxConcurrent();
    const mcf = manager.getMaxConcurrentForeground();
    const dmt = getDefaultMaxTurns() ?? 0;
    const gt = getGraceTurns();
    const msd = getMaxSubagentDepth();
    // Label what unset actually does — it targets general-purpose even when
    // that is unregistered (the permissive hardcoded tier), so showing "none"
    // there would advertise strict dispatch for the most permissive state.
    // `values` still offers only resolvable targets, so the user cannot
    // persist a fallback that would hard-error on every dispatch.
    const fallbackValue = getFallbackSubagent() ?? "general-purpose";
    const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

    return [
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: String(mc),
        values: [String(mc)],
      },
      {
        id: "maxConcurrentForeground",
        label: "Max foreground concurrency",
        description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
        currentValue: String(mcf),
        values: [String(mcf)],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: String(dmt),
        values: [String(dmt)],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: String(gt),
        values: [String(gt)],
      },
      {
        id: "maxSubagentDepth",
        label: "Nested depth",
        description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
        currentValue: String(msd),
        values: [String(msd)],
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
        description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
        currentValue: settings.backgroundByDefault ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "schedulingEnabled",
        label: "Scheduling",
        description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
        currentValue: settings.schedulingEnabled ? "on" : "off",
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
        id: "disableDefaultAgents",
        label: "Disable defaults",
        description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
        currentValue: isDefaultsDisabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "fallbackSubagent",
        label: "Fallback agent",
        description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
        currentValue: fallbackValue,
        values: fallbackValues,
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
          "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
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
          "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
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
        description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
        currentValue: settings.fleetView ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "agentMentions",
        label: "Agent mentions",
        description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
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
        description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
        currentValue: settings.toolDescriptionMode,
        values: ["full", "compact", "custom"],
      },
    ];
  }

  function applyValue(id: string, value: string) {
    if (id === "maxConcurrent") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        manager.setMaxConcurrent(n);
        settingsPersist.notifyApplied(ctx, `Max concurrency set to ${n}`);
      }
    } else if (id === "maxConcurrentForeground") {
      // 0 is meaningful here, unlike maxConcurrent above: it means unlimited.
      const n = parseInt(value, 10);
      if (n >= 0) {
        manager.setMaxConcurrentForeground(n);
        settingsPersist.notifyApplied(ctx, n === 0
          ? "Max foreground concurrency set to unlimited"
          : `Max foreground concurrency set to ${n}`);
      }
    } else if (id === "defaultMaxTurns") {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        settingsPersist.notifyApplied(ctx, "Default max turns set to unlimited");
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        settingsPersist.notifyApplied(ctx, `Default max turns set to ${n}`);
      }
    } else if (id === "graceTurns") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        settingsPersist.notifyApplied(ctx, `Grace turns set to ${n}`);
      }
    } else if (id === "maxSubagentDepth") {
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
    } else if (id === "joinMode") {
      appliers.setDefaultJoinMode(value as JoinMode);
      settingsPersist.notifyApplied(ctx, `Default join mode set to ${value}`);
    } else if (id === "backgroundByDefault") {
      const enabled = value === "on";
      appliers.setBackgroundByDefault(enabled);
      settingsPersist.notifyApplied(
        ctx,
        enabled
          ? "Agent calls run in the background unless they pass run_in_background: false"
          : "Agent calls block and return inline unless they pass run_in_background: true",
      );
    } else if (id === "schedulingEnabled") {
      const enabled = value === "on";
      if (enabled === settings.schedulingEnabled) {
        ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        appliers.setSchedulingEnabled(enabled);
        if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
        settingsPersist.notifyApplied(
          ctx,
          `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
        );
      }
    } else if (id === "scopeModels") {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      settingsPersist.notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "strictAgentFiles") {
      const enabled = value === "on";
      appliers.setStrictAgentFiles(enabled);
      settingsPersist.notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
    } else if (id === "disableDefaultAgents") {
      const enabled = value === "on";
      appliers.setDisableDefaultAgents(enabled);
      settingsPersist.notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
    } else if (id === "fallbackSubagent") {
      setFallbackSubagent(value);
      settingsPersist.notifyApplied(
        ctx,
        value === NO_FALLBACK
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
      );
    } else if (id === "outputTranscript") {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      settingsPersist.notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
    } else if (id === "worktreeIsolation") {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      // The refusal is live, but the tool schema is built at registration, so
      // the isolation parameter only appears/disappears next session.
      settingsPersist.notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
      );
    } else if (id === "toolDescriptionMode") {
      appliers.setToolDescriptionMode(value as ToolDescriptionMode);
      settingsPersist.notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
    } else if (id === "reportUsage") {
      const enabled = value === "on";
      appliers.setReportUsage(enabled);
      settingsPersist.notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
      );
    } else if (id === "showCost") {
      const enabled = value === "on";
      appliers.setShowCost(enabled);
      settingsPersist.notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "showModel") {
      const enabled = value === "on";
      appliers.setShowModel(enabled);
      settingsPersist.notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "viewerMarkdown") {
      appliers.setViewerMarkdown(value as ViewerMarkdownMode);
      settingsPersist.notifyApplied(ctx, `Viewer markdown set to ${value}`);
    } else if (id === "fleetView") {
      const enabled = value === "on";
      appliers.setFleetView(enabled);
      settingsPersist.notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "agentMentions") {
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
    } else if (id === "rememberAgents") {
      const enabled = value === "on";
      setRememberAgents(enabled);
      settingsPersist.notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "widgetMode") {
      appliers.setWidgetMode(value as WidgetMode);
      settingsPersist.notifyApplied(ctx, `Widget set to ${value}`);
    }
  }

  let list: SettingsList;
  // Track current selection index directly (SettingsList doesn't expose it).
  // Updated on arrow keys so Enter knows which field is selected immediately.
  let currentIndex = 0;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applyValue(id, newValue);
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
        // Track navigation so Enter knows the current field
        if (matchesKey(data, "up")) {
          currentIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(data, "down")) {
          currentIndex = Math.min(items.length - 1, currentIndex + 1);
        }

        // Enter on numeric field → close and prompt for typed input
        if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
          done(items[currentIndex].id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  // If a numeric field ID was returned, prompt for typed input
  if (result && NUMERIC_IDS.has(result)) {
    const current = result === "maxConcurrent"
      ? String(manager.getMaxConcurrent())
      : result === "maxConcurrentForeground"
        ? String(manager.getMaxConcurrentForeground())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : result === "maxSubagentDepth"
            ? String(getMaxSubagentDepth())
            : String(getGraceTurns());

    const label = result === "maxConcurrent"
      ? "Max concurrency (1+)"
      : result === "maxConcurrentForeground"
        ? "Max foreground concurrency (0 = unlimited)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : result === "maxSubagentDepth"
            ? "Nested depth (0/1 = nesting off)"
            : "Grace turns (1+)";

    // Loop until user enters a valid integer or cancels (Esc / null).
    // Silently trims whitespace; rejects non-numeric input by re-prompting.
    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applyValue(result, String(n));
        await showSettings(ctx, deps);
        return;
      }
      // Invalid — re-prompt with the user's last entry so they can edit it
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
