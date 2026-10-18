/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 *
 * Size: runAgent is one ordered setup sequence (prompt, extensions, tools, session, turn limits) whose steps share local state.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getToolNamesForType } from "./agent-types.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { extensionCanonicalNames, extensionConfigWarnings, installExtensionToolScope, parseExtSelectors, planExtensionLoad, resolveSessionToolScope } from "./extension-scope.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "./nested-tools.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { getGraceTurns, getRememberAgents, resolveEffectiveMaxTurns, turnLimitAction } from "./runner-defaults.js";
import { collectResponseText, finalTurnError, getLastAssistantText } from "./session-text.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, SubagentType, ThinkingLevel } from "./types.js";
import { assistantUsage, type LifetimeUsage } from "./usage.js";

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
export function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Run under this definition instead of the registry entry for `type`. Set by
   * a cross-extension spawn that carries its agent inline; `type` then only
   * names the run.
   */
  agentConfig?: AgentConfig;
  /**
   * Reopen this pi session file rather than starting an empty conversation.
   * `createAgentSession` seeds itself from whatever its SessionManager holds,
   * so pointing it at an existing file rehydrates that agent's history and the
   * prompt continues it. Everything else — tools, model, system prompt, turn
   * caps — is still resolved from the agent type, so the continuation runs
   * under the type's *current* definition, not the one the original run used.
   */
  resumeSessionFile?: string;
  /**
   * True when another agent spawned this one. Only top-level agents get a
   * handle, so only they can be reopened by name — which is the whole reason
   * `rememberAgents` persists a session at all. A nested run's transcript would
   * be unreachable by anything, so it stays in memory unless its own
   * frontmatter asks otherwise.
   */
  nested?: boolean;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Directory the worktree copy was created from. Set only when `cwd` points
   * into a worktree — the prompt then tells the agent to stay in the copy
   * instead of following the inherited parent prompt back to the main tree.
   */
  worktreeBase?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   *
   * `cost` is pi's own `usage.cost.total` for that message — priced from the
   * model's rates, so it is 0 (not missing) for a model pi has no pricing for.
   * We never price anything ourselves; every dollar figure this extension shows
   * or reports traces back to this field.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /** Runtime bridge for opt-in child-safe nested delegation. */
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    depth: number;
    maxSubagentDepth?: number;
  };
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

interface SessionEventCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

/** Forward tool activity, assistant usage and compaction events to the caller's callbacks. */
function forwardSessionEvent(event: AgentSessionEvent, callbacks: SessionEventCallbacks): void {
  if (event.type === "tool_execution_start") {
    callbacks.onToolActivity?.({ type: "start", toolName: event.toolName });
  } else if (event.type === "tool_execution_end") {
    callbacks.onToolActivity?.({ type: "end", toolName: event.toolName });
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    const usage = assistantUsage(event.message);
    if (usage) callbacks.onAssistantUsage?.(usage);
  } else if (event.type === "compaction_end" && !event.aborted && event.result) {
    callbacks.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
  }
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

/**
 * Subscribe to a run's session events: graceful max_turns enforcement (steer at the
 * soft limit, abort after the grace turns), text deltas, and the caller's callbacks.
 * `aborted` and `steered` are live fields, read after the prompt settles.
 */
function trackRunEvents(session: AgentSession, options: RunOptions, maxTurns: number | undefined) {
  const state = {
    aborted: false,
    steered: false,
    unsubscribe: () => {},
  };
  let turnCount = 0;
  let currentMessageText = "";
  state.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      const action = turnLimitAction(turnCount, maxTurns, state.steered, getGraceTurns());
      if (action === "steer") {
        state.steered = true;
        session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
      } else if (action === "abort") {
        state.aborted = true;
        session.abort();
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    forwardSessionEvent(event, options);
  });
  return state;
}

/**
 * Extension and skill inputs for a run. `isolated` overrides them to none. Nulling
 * excludes under isolated also suppresses the orphaned-exclude warning —
 * isolation is an intentional override, not a misconfiguration.
 */
function resolveExtensionInputs(
  options: RunOptions,
  config: Pick<AgentConfig, "extensions" | "excludeExtensions" | "skills">,
  agentConfig: AgentConfig | undefined,
) {
  if (options.isolated) {
    return { extensions: false as const, excludeExtensions: undefined, skills: false as const, extSelectors: [] };
  }
  return {
    extensions: config.extensions,
    excludeExtensions: config.excludeExtensions,
    skills: config.skills,
    extSelectors: agentConfig?.extSelectors ?? [],
  };
}

function buildRunSystemPrompt(
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  cwd: string,
  env: Awaited<ReturnType<typeof detectEnv>>,
  parentSystemPrompt: string,
  extras: PromptExtras,
): string {
  if (agentConfig) return buildAgentPrompt(agentConfig, cwd, env, parentSystemPrompt, extras);
  // Unknown type fallback: spread the canonical general-purpose config (defensive —
  // unreachable in practice since index.ts resolves unknown types before calling runAgent).
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return buildAgentPrompt({ ...fallback, name: type }, cwd, env, parentSystemPrompt, extras);
}

/**
 * Nested delegation tools (opt-in, ownership-scoped). Empty unless the agent
 * set `allowed_subagents` and a nestedRuntime was provided — and never when
 * isolated. At (or past) the depth cap the agent can never spawn, so it can never
 * own a child to fetch from or steer either: inject nothing rather than tools
 * whose every call is an error. That makes `maxSubagentDepth` 0/1 mean "nesting off".
 */
function resolveNestedTools(options: RunOptions, agentConfig: AgentConfig | undefined, configCwd: string) {
  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  if (!agentConfig?.allowedSubagents || !nestedRuntime || options.isolated) return [];
  return createNestedSubagentTools({
    manager: nestedRuntime.manager,
    pi: options.pi,
    parentAgentId: nestedRuntime.parentAgentId,
    depth: nestedRuntime.depth,
    maxSubagentDepth: effectiveMaxDepth,
    allowedSubagents: agentConfig.allowedSubagents,
    configCwd,
  });
}

function createRunSessionManager(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: AgentConfig | undefined,
  effectiveCwd: string,
  settingsManager: SettingsManager,
): SessionManager {
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const sessionDir = configuredSessionDir ?? defaultSessionDir;
  // Reopening an existing conversation: the file already carries its own
  // header (cwd, parent) and history, so none of the create-time options
  // apply. `sessionDir` still matters for a later /new or /branch off it.
  if (options.resumeSessionFile) return SessionManager.open(options.resumeSessionFile, sessionDir);
  // Frontmatter wins when it says anything; otherwise the project default,
  // which `rememberAgents` supplies for top-level agents only. Same precedence
  // as `outputTranscript`.
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : getRememberAgents());
  if (!persistSession) return SessionManager.inMemory(effectiveCwd);
  return SessionManager.create(effectiveCwd, sessionDir, {
    // Optional metadata — it only nests the subagent under its spawner in
    // `/resume`. A context without a session manager (a bare programmatic ctx)
    // must still persist rather than take the whole spawn down.
    parentSession: ctx.sessionManager?.getSessionFile?.(),
  });
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const inline = options.agentConfig;
  const config = inline ?? getConfig(type);
  const agentConfig = inline ?? getAgentConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (skill preloading)
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;

  const { extensions, excludeExtensions, skills, extSelectors } = resolveExtensionInputs(options, config, agentConfig);

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  const toolNames = inline ? (inline.builtinToolNames ?? [...BUILTIN_TOOL_NAMES]) : getToolNamesForType(type);

  // Build system prompt from agent config
  const systemPrompt = buildRunSystemPrompt(type, agentConfig, effectiveCwd, env, parentSystemPrompt, extras);

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(extSelectors);
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  const plan = planExtensionLoad(extensions, excludeExtensions, configCwd);
  const { noExtensions, keepNames, excludeNames } = plan;

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths: plan.additionalExtensionPaths,
    extensionsOverride: plan.extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  for (const name of agentConfig?.builtinToolNames ?? []) {
    if (BUILTIN_TOOL_NAMES.includes(name)) continue;
    options.onToolActivity?.({
      type: "end",
      toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
    });
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. discoveredNames is read here, after reload() has filled it.
  const warnings = extensionConfigWarnings({
    type,
    noExtensions,
    keepNames,
    excludeNames,
    extNames,
    discoveredNames: plan.discoveredNames(),
    getSurvivingNames: () =>
      new Set(loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path))),
  });
  for (const toolName of warnings) options.onToolActivity?.({ type: "end", toolName });

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  const nestedTools = resolveNestedTools(options, agentConfig, configCwd);
  const nestedToolNames = new Set(nestedTools.map(tool => tool.name));

  // Re-admitted at every gate below. `disallowed_tools` is applied HERE rather
  // than at the gates: a nested delegation tool is an opt-in the agent's own
  // frontmatter can take back.
  const readmitToolNames = new Set(
    [...nestedToolNames].filter(name => !disallowedSet?.has(name)),
  );

  // ─── Tool scoping ───────────────────────────────────────────────────────
  //
  // Some extensions register their tools ASYNCHRONOUSLY, long after the
  // `loader.reload()` above: pi-mcp calls registerTool from `session_start`
  // (once its MCP servers connect), context-mode from `before_agent_start`.
  // That is deliberate on their part — eagerly spawning an MCP bridge during
  // extension discovery orphans child processes on pi's non-agent code paths
  // (--help, config, trust probing).
  //
  // So the tool set cannot be snapshotted here. pi's `allowedToolNames` gates
  // tool *registration* (`_refreshToolRegistry`'s `isAllowedTool`), not merely
  // the active set, and is frozen at construction — a name absent from the
  // snapshot is dropped forever, even once the tool actually registers (#125).
  //
  // Whenever extensions are in play we therefore:
  //   - leave `allowedToolNames` unset, so pi's live gate admits tools whenever
  //     they register;
  //   - express the name-stable, permanent part of the scope (our own
  //     orchestration tools, built-ins the agent didn't ask for, and
  //     `disallowedTools`) as `excludeTools`, which pi re-applies on every
  //     registry refresh;
  //   - enforce `ext:` narrowing on the ACTIVE set via the live `inScope()`
  //     predicate installed after bind — the active set is what the LLM sees,
  //     so a registry tool that is never activated is invisible and uncallable.
  //
  // `noExtensions`/`isolated` keeps the historical static allowlist: nothing
  // async can appear there, and a hard registry gate is the correct boundary.
  const { sessionTools, sessionExcludeTools } = resolveSessionToolScope({
    noExtensions,
    toolNames,
    disallowedSet,
    nestedToolNames,
  });

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const sessionManager = createRunSessionManager(ctx, options, agentConfig, effectiveCwd, settingsManager);

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: unknown;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    // `as never` is what keeps this assignable across the supported Pi range:
    // pre-0.80.8 the field exists only via the `modelRuntime?: unknown` shim
    // above, while newer Pi types it as `ModelRuntime` — a shape an opaque
    // `unknown` read off the private facade field can never satisfy.
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    model,
    tools: sessionTools,
    customTools: nestedTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  // With `allowedToolNames` unset, the registry is scoped by `excludeTools` but
  // the ACTIVE set still needs managing: pi activates only its four default
  // built-ins at turn 1, and `ext:` narrowing has no registry-level expression
  // (we can't deny the name of a tool that hasn't registered yet). Both are
  // handled below by re-deriving scope from the loader's live extension maps —
  // `registerTool` writes into those same maps, so late arrivals are judged too.
  if (!noExtensions) {
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      readmitToolNames,
    });
  }

  options.onSessionCreated?.(session);

  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns, agentConfig);
  const turns = trackRunEvents(session, options, maxTurns);

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  const parentContext = options.inheritContext ? buildParentContext(ctx) : undefined;
  const effectivePrompt = parentContext ? parentContext + prompt : prompt;

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (a fresh session, so usually 0).
  const startLen = session.messages.length;
  try {
    await session.prompt(effectivePrompt);
  } finally {
    turns.unsubscribe();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  return {
    responseText,
    session,
    aborted: turns.aborted,
    steered: turns.steered,
    failure: finalTurnError(session, startLen),
  };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: LifetimeUsage) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; failure?: string }> {
  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents = (options.onToolActivity || options.onAssistantUsage || options.onCompaction)
    ? session.subscribe((event: AgentSessionEvent) => forwardSessionEvent(event, options))
    : () => {};

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    failure: finalTurnError(session, startLen),
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}
