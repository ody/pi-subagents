import type { SettingItem } from "@earendil-works/pi-tui";
import type { SubagentsSettings } from "../config/settings.js";

export interface SettingRowDef {
  id: keyof SubagentsSettings;
  label: string;
  description: string;
  values?: readonly string[];
}

const ON_OFF = ["on", "off"] as const;

export const SETTING_ROWS: readonly SettingRowDef[] = [
  {
    id: "maxConcurrent",
    label: "Max concurrency",
    description: "Max concurrent background agents (Enter to type)",
  },
  {
    id: "maxConcurrentForeground",
    label: "Max foreground concurrency",
    description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
  },
  {
    id: "defaultMaxTurns",
    label: "Default max turns",
    description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
  },
  {
    id: "graceTurns",
    label: "Grace turns",
    description: "Grace turns after wrap-up steer (Enter to type)",
  },
  {
    id: "maxSubagentDepth",
    label: "Nested depth",
    description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
  },
  {
    id: "defaultJoinMode",
    label: "Join mode",
    description: "Default join mode for background agents",
    values: ["smart", "async", "group"],
  },
  {
    id: "backgroundByDefault",
    label: "Background by default",
    description: "An agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
    values: ON_OFF,
  },
  {
    id: "scopeModels",
    label: "Scope models",
    description: "Validate subagent models against scoped models (/scoped-models)",
    values: ON_OFF,
  },
  {
    id: "strictAgentFiles",
    label: "Strict agent files",
    description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
    values: ON_OFF,
  },
  {
    id: "outputTranscript",
    label: "Output transcript",
    description:
      "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
    values: ON_OFF,
  },
  {
    id: "worktreeIsolation",
    label: "Worktree isolation",
    description:
      "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the agent tool spec on next pi session.",
    values: ON_OFF,
  },
  {
    id: "reportUsage",
    label: "Report usage to session",
    description:
      "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
    values: ON_OFF,
  },
  {
    id: "showCost",
    label: "Show cost",
    description:
      "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
    values: ON_OFF,
  },
  {
    id: "showModel",
    label: "Show model",
    description:
      "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
    values: ON_OFF,
  },
  {
    id: "viewerMarkdown",
    label: "Viewer markdown",
    description:
      "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
    values: ["off", "assistant", "all"],
  },
  {
    id: "fleetView",
    label: "Fleet view",
    description: "Navigable main+subagents tree below the editor (↓/← to navigate, Enter to view)",
    values: ON_OFF,
  },
  {
    id: "agentMentions",
    label: "Agent mentions",
    description:
      "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
    values: ["model", "direct", "off"],
  },
  {
    id: "rememberAgents",
    label: "Remember agents",
    description:
      "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
    values: ON_OFF,
  },
  {
    id: "widgetMode",
    label: "Widget",
    description:
      "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
    values: ["all", "background", "off"],
  },
  {
    id: "toolDescriptionMode",
    label: "Tool description",
    description:
      "agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
    values: ["full", "compact", "custom"],
  },
];

export function displayValue(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "on" : "off") : String(value);
}

export function buildItems(values: Required<SubagentsSettings>): SettingItem[] {
  return SETTING_ROWS.map((row) => {
    const currentValue = displayValue(values[row.id]);
    return {
      id: row.id,
      label: row.label,
      description: row.description,
      currentValue,
      values: row.values ? [...row.values] : [currentValue],
    };
  });
}
