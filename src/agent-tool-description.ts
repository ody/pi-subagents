import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes } from "./agent-types.js";
import { getModelLabelFromConfig } from "./model-resolver.js";
import type { ToolDescriptionMode } from "./settings.js";
import type { AgentConfig } from "./types.js";

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

/** Build the full type list text dynamically from available agents only. */
const buildTypeListText = () => {
  const available = getAvailableTypes();

  return available.map((name) => {
    const cfg = getAgentConfig(name);
    const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
    return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
  }).join("\n");
};

/** First sentence of an agent description — for the compact type list. */
export const firstSentence = (text: string): string => {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
};

/** Compact type list: one line per agent, first sentence only. */
const buildCompactTypeListText = () =>
  getAvailableTypes().map((name) => {
    const cfg = getAgentConfig(name);
    return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
  }).join("\n");

/**
 * Build the Agent tool description for the given mode. Read once at tool
 * definition: scheduling and worktree isolation follow the persisted settings
 * at that moment.
 */
export function buildAgentToolDescription(o: {
  mode: ToolDescriptionMode;
  schedulingEnabled: boolean;
  worktreeEnabled: boolean;
}): string {
  const scheduleGuideline = o.schedulingEnabled
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = o.worktreeEnabled
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = o.worktreeEnabled
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const mode = o.mode;
  if (mode === "compact") return compactAgentToolDescription;
  if (mode === "custom") {
    const custom = loadCustomToolDescription();
    if (custom) return custom;
    console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
  }
  return fullAgentToolDescription;
}
