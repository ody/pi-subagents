// Size: runAgent is one ordered setup sequence (prompt, extensions, tools, session, turn limits) whose steps share local state.

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
  type LoadExtensionsResult,
  type ModelRuntime,
  type ResourceDiagnostic,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig } from "../agents/agent-types.js";
import type { EffectiveCapabilities, GrantedCapability } from "../config/capability-policy.js";
import { loadCapabilityPolicy } from "../config/capability-policy-config.js";
import { discoverKnown, policyHasEntries, unknownPolicyEntries } from "../config/policy-unknown-entries.js";
import { getGraceTurns, getRememberAgents, resolveEffectiveMaxTurns, turnLimitAction } from "../config/runner-defaults.js";
import { detectEnv } from "../platform/env.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "../tool/nested-tools.js";
import type { AgentConfig, SubagentType, ThinkingLevel } from "../types.js";
import { assistantUsage, type LifetimeUsage } from "../usage.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext } from "./context.js";
import { extensionCanonicalNames, extensionConfigWarnings, installExtensionToolScope, parseExtSelectors, planExtensionLoad, resolveSessionToolScope } from "./extension-scope.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { collectResponseText, finalTurnError, getLastAssistantText } from "./session-text.js";
import { preloadSkills } from "./skill-loader.js";

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

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  pi: ExtensionAPI;
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  agentConfig?: AgentConfig;
  capability: GrantedCapability;
  resumeSessionFile?: string;
  nested?: boolean;
  cwd?: string;
  worktreeBase?: string;
  configCwd?: string;
  notify?: (message: string, level: "warning") => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
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
  aborted: boolean;
  steered: boolean;
  failure?: string;
}

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

function resolveExtensionInputs(options: RunOptions, capabilities: EffectiveCapabilities) {
  if (options.isolated) {
    return { extensions: false as const, excludeExtensions: undefined, skills: false as const, extSelectors: [] };
  }
  return {
    extensions: capabilities.extensions,
    excludeExtensions: capabilities.excludeExtensions,
    skills: capabilities.skills,
    extSelectors: capabilities.extSelectors,
  };
}

function skillsOverrideFor(capabilities: EffectiveCapabilities) {
  const { allow, deny } = capabilities.skillScope;
  if (capabilities.skills !== true || (!allow && deny.length === 0)) return undefined;
  const denied = new Set(deny.map(name => name.toLowerCase()));
  const allowed = allow ? new Set(allow.map(name => name.toLowerCase())) : undefined;
  return (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => ({
    ...base,
    skills: base.skills.filter(skill => {
      const key = skill.name.toLowerCase();
      return !denied.has(key) && (!allowed || allowed.has(key));
    }),
  });
}

function resolveNestedTools(options: RunOptions, capabilities: EffectiveCapabilities, configCwd: string) {
  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  if (!capabilities.allowedSubagents || !nestedRuntime || options.isolated) return [];
  return createNestedSubagentTools({
    manager: nestedRuntime.manager,
    pi: options.pi,
    parentAgentId: nestedRuntime.parentAgentId,
    depth: nestedRuntime.depth,
    maxSubagentDepth: effectiveMaxDepth,
    allowedSubagents: capabilities.allowedSubagents,
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
  if (options.resumeSessionFile) return SessionManager.open(options.resumeSessionFile, sessionDir);
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : getRememberAgents());
  if (!persistSession) return SessionManager.inMemory(effectiveCwd);
  return SessionManager.create(effectiveCwd, sessionDir, {
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
  const agentConfig = inline ?? getAgentConfig(type);
  if (!agentConfig) throw new Error(`Unknown agent type "${type}" and no inline agent definition given`);
  const capabilities = options.capability.capabilities;

  const effectiveCwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  const parentSystemPrompt = ctx.getSystemPrompt();

  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;

  const { extensions, excludeExtensions, skills, extSelectors } = resolveExtensionInputs(options, capabilities);

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  const toolNames = capabilities.builtinToolNames;

  const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);

  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  const { extNames, narrowing } = parseExtSelectors(extSelectors);
  const plan = planExtensionLoad(extensions, excludeExtensions, configCwd);
  const { noExtensions, keepNames, excludeNames } = plan;

  let discoveredExtensions: LoadExtensionsResult | undefined;
  const policy = loadCapabilityPolicy(configCwd);
  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths: plan.additionalExtensionPaths,
    extensionsOverride: policyHasEntries(policy)
      ? base => {
          discoveredExtensions = base;
          return plan.extensionsOverride ? plan.extensionsOverride(base) : base;
        }
      : plan.extensionsOverride,
    noSkills,
    skillsOverride: skillsOverrideFor(capabilities),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());

  for (const name of capabilities.builtinToolNames) {
    if (BUILTIN_TOOL_NAMES.includes(name)) continue;
    options.onToolActivity?.({
      type: "end",
      toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
    });
  }

  const policyWarnings = unknownPolicyEntries(
    policy,
    configCwd,
    () => discoverKnown(configCwd, agentDir, discoveredExtensions),
  );
  for (const message of policyWarnings) options.notify?.(message, "warning");

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

  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const disallowedSet = capabilities.disallowedTools.length > 0
    ? new Set(capabilities.disallowedTools)
    : undefined;

  const nestedTools = resolveNestedTools(options, capabilities, configCwd);
  const nestedToolNames = new Set(nestedTools.map(tool => tool.name));

  const readmitToolNames = new Set(
    [...nestedToolNames].filter(name => !disallowedSet?.has(name)),
  );

  const { sessionTools, sessionExcludeTools } = resolveSessionToolScope({
    noExtensions,
    toolNames,
    disallowedSet,
    nestedToolNames,
  });

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const sessionManager = createRunSessionManager(ctx, options, agentConfig, effectiveCwd, settingsManager);

  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRuntime: parentModelRuntime,
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

  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  if (!noExtensions) {
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      readmitToolNames,
      deniedExtNames: new Set(capabilities.deniedExtensionNames),
      noExtensionTools: capabilities.noExtensionTools,
    });
  }

  options.onSessionCreated?.(session);

  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns, agentConfig);
  const turns = trackRunEvents(session, options, maxTurns);

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const parentContext = options.inheritContext ? buildParentContext(ctx) : undefined;
  const effectivePrompt = parentContext ? parentContext + prompt : prompt;

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

export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}
