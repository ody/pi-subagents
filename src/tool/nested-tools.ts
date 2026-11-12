import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildAgentRegistry,
  getAgentConfigIn,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "../agents/agent-types.js";
import { loadCustomAgents } from "../agents/custom-agents.js";
import { resolveModel } from "../config/model-resolver.js";
import { checkModelScope } from "../config/model-scope.js";
import {
  createOutputFilePath,
  getOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "../platform/output-file.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import type {
  AgentConfig,
  AgentInvocation,
  AgentRecord,
  IsolationMode,
  ThinkingLevel,
} from "../types.js";
import { addUsage } from "../usage.js";
import { abortable } from "./abortable.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { getForegroundOutcomeNote, getStatusNote, partialOutputSuffix } from "./status-note.js";

let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

export const NESTED_TOOL_NAMES = ["agent", "get_subagent_result", "steer_subagent", "stop_subagent"] as const;

interface NestedSpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onSessionCreated?: (session: AgentSession) => void;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd?: string;
  rootSessionId?: string;
}

export interface NestedAgentManager {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: NestedSpawnOptions,
  ): string;
  awaitStartup(id: string): Promise<void>;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<NestedSpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }>;
  getRecord(id: string): AgentRecord | undefined;
  resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
  abort(id: string): boolean;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  allowedSubagents: "all" | string[];
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

type ResultPosition = "inline" | "fetched";

function formatRecord(record: AgentRecord, position: ResultPosition): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  const text = record.result?.trim() || record.error?.trim() || "No output.";
  const note = position === "inline"
    ? getForegroundOutcomeNote(record.status, record.stoppedBy)
    : getStatusNote(record.status, record.stoppedBy);
  return note ? `Nested agent${note}.\n\n${text}` : text;
}

async function resumeOwned(
  manager: NestedAgentManager,
  parentAgentId: string,
  id: string,
  prompt: string,
  signal: AbortSignal | undefined,
) {
  const existing = manager.getRecord(id);
  if (!ownsRecord(existing, parentAgentId)) {
    return textResult(`Nested agent not found or not owned by this parent: "${id}".`, true);
  }
  const resumed = await manager.resume(id, prompt, signal);
  return resumed
    ? textResult(formatRecord(resumed, "inline"), resumed.status === "error")
    : textResult(`Failed to resume nested agent "${id}".`, true);
}

export function resolveNestedType(
  registry: Map<string, AgentConfig>,
  rawType: string,
  allowed: Set<string> | undefined,
): { type: string } | { error: string } {
  const resolvedType = resolveEnabledTypeIn(registry, rawType);
  if (resolvedType === undefined) {
    const available = getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
    return { error: `Unknown or disabled nested agent type: "${rawType}". Allowed: ${available.join(", ") || "none"}.` };
  }
  if (allowed !== undefined && !allowed.has(resolvedType)) {
    return { error: `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.` };
  }
  return { type: resolvedType };
}

export function resolveNestedModel(
  invocation: { modelInput?: string; modelFromParams: boolean },
  ctxModel: Model<any> | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
): { model: Model<any> | undefined } | { error: string } {
  if (!invocation.modelInput) return { model: ctxModel };
  const resolved = resolveModel(invocation.modelInput, modelRegistry);
  if (typeof resolved !== "string") return { model: resolved };
  return invocation.modelFromParams ? { error: resolved } : { model: ctxModel };
}

export function addUsageToAncestors(
  manager: Pick<NestedAgentManager, "getRecord">,
  parentAgentId: string,
  usage: { input: number; output: number; cacheWrite: number },
): void {
  for (let id: string | undefined = parentAgentId; id !== undefined; ) {
    const ancestor = manager.getRecord(id);
    if (!ancestor) break;
    addUsage(ancestor.lifetimeUsage, usage);
    id = ancestor.parentAgentId;
  }
}

export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      max_turns: Type.Optional(Type.Number({ minimum: 0 })),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to false for nested spawns — the call blocks and returns the child's result inline. Set true only for work you will collect later with get_subagent_result; a detached child is stopped when you finish.",
        }),
      ),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        return resumeOwned(context.manager, context.parentAgentId, params.resume, params.prompt, signal);
      }

      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      const registry = loadRegistry();
      const typeResult = resolveNestedType(registry, params.subagent_type, allowedTypesIn(registry));
      if ("error" in typeResult) return textResult(typeResult.error, true);
      const resolvedType = typeResult.type;

      const config = getAgentConfigIn(registry, resolvedType);
      const invocation = resolveAgentInvocationConfig(config, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: false,
      });
      const modelResult = resolveNestedModel(invocation, ctx.model, ctx.modelRegistry);
      if ("error" in modelResult) return textResult(modelResult.error, true);
      const model = modelResult.model;

      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: invocation.modelFromParams,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId;
      const childDepth = context.depth + 1;
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        onAssistantUsage: usage => addUsageToAncestors(context.manager, context.parentAgentId, usage),
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
      };

      const transcriptSessionId =
        rootSessionId !== undefined && (config?.outputTranscript ?? getOutputTranscriptDefault())
          ? rootSessionId
          : undefined;
      let childId: string | undefined;
      const attachTranscript = (id: string): void => {
        childId = id;
        if (transcriptSessionId === undefined) return;
        const rec = context.manager.getRecord(id);
        if (!rec) return;
        rec.outputFile = createOutputFilePath(context.configCwd, id, transcriptSessionId);
        writeInitialEntry(rec.outputFile, id, params.prompt, ctx.cwd);
      };
      options.onSessionCreated = (session) => {
        const rec = childId === undefined ? undefined : context.manager.getRecord(childId);
        if (rec?.outputFile && childId !== undefined) {
          rec.outputCleanup = streamToOutputFile(session, rec.outputFile, childId, ctx.cwd);
        }
      };

      try {
        if (invocation.runInBackground) {
          const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
            ...options,
            isBackground: true,
          });
          attachTranscript(id);
          await context.manager.awaitStartup(id);
          return textResult(`Nested agent started in background. Agent ID: ${id}`);
        }

        const { record } = await context.manager.spawnAndWait(
          context.pi,
          ctx,
          resolvedType,
          params.prompt,
          { ...options, signal },
          attachTranscript,
        );
        return textResult(formatRecord(record, "inline"), record.status === "error");
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (params.wait && (record.status === "queued" || record.status === "running")) {
        while (record.status === "queued") {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), signal);
        }
        if (record.promise) await abortable(record.promise, signal);
      }
      return textResult(formatRecord(record, "fetched"), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  const stopTool = defineTool({
    name: NESTED_TOOL_NAMES[3],
    label: "Stop Nested Agent",
    description:
      "Stop a running or queued nested agent owned by this parent. Its result arrives through the completion " +
      "notification only if it finishes — a stopped agent's notification carries any partial output.",
    parameters: Type.Object({
      agent_id: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Nested agent ${record.id} is not running (status: ${record.status}). Its result is still available.`);
      }
      const wasRunning = record.status === "running";
      record.stoppedBy = "agent";
      context.manager.abort(record.id);
      return textResult(
        wasRunning
          ? `Nested agent ${record.id} stopped.`
          : `Nested agent ${record.id} stopped before it started running. No output was produced.`,
      );
    },
  });

  return [agentTool, resultTool, steerTool, stopTool];
}
