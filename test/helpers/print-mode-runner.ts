import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type Context,
  type FauxContentBlock,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxModelBackend } from "./faux-model-backend.js";
import { getModel, registerFauxProvider } from "./pi-ai.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface ManagerHandle {
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  getRecord(id: string): unknown;
}

export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;

export type FauxResponder = (
  context: Context,
  state: { callCount: number },
) => FauxReply | Promise<FauxReply>;

export interface RunPrintModeOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  respond?: FauxResponder;
  steps?: FauxResponseStep[];
  maxModelCalls?: number;
  hold?: boolean;
  beforeRun?: () => void | Promise<void>;
  isolateGlobals?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  live?: { provider: string; model: string } | false;
}

export interface PrintModeRun {
  responseText: string;
  parentSession: AgentSession;
  manager: ManagerHandle | undefined;
  subagents: Array<Record<string, unknown>>;
  modelCalls: number;
  dispose: () => Promise<void>;
}

export function agentCall(
  args: {
    prompt: string;
    description: string;
    subagent_type?: string;
    run_in_background?: boolean;
    [k: string]: unknown;
  },
  opts?: { id?: string },
): ToolCall {
  return fauxToolCall("agent", { subagent_type: "general-purpose", ...args }, opts);
}

export function contextToolNames(context: Pick<Context, "messages">): string[] {
  const names = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
  }
  return [...names];
}

export function contextSystemPrompt(context: Pick<Context, "messages">): string {
  const parts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    parts.push(typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join(""));
    for (const section of Object.values(message.sections ?? {})) if (section) parts.push(section);
  }
  return parts.join("\n");
}

function resolveReply(
  reply: FauxReply | ((ctx: Context) => FauxReply),
  ctx: Context,
): FauxReply {
  return typeof reply === "function" ? (reply as (c: Context) => FauxReply)(ctx) : reply;
}

export function routeBySession(routes: {
  parentInitial: FauxReply | ((ctx: Context) => FauxReply);
  parentFinal?: FauxReply | ((ctx: Context) => FauxReply);
  subagent: FauxReply | ((ctx: Context) => FauxReply);
}): FauxResponder {
  return (context) => {
    const isParent = contextToolNames(context).includes("agent");
    if (!isParent) return resolveReply(routes.subagent, context);
    const spawned = context.messages.some(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "agent",
    );
    if (spawned) {
      return routes.parentFinal != null
        ? resolveReply(routes.parentFinal, context)
        : "Done.";
    }
    return resolveReply(routes.parentInitial, context);
  };
}

function toAssistantMessage(reply: FauxReply): AssistantMessage {
  if (reply && typeof reply === "object" && "role" in reply) {
    return reply as AssistantMessage;
  }
  const content: FauxContentBlock[] =
    typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
  const hasToolCall = content.some((b) => (b as { type?: string }).type === "toolCall");
  return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a headless orchestrator. Use the agent tool to delegate, then report the result.";

function isLive(options: RunPrintModeOptions): boolean {
  if (options.live === false) return false;
  return Boolean(options.live) || /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");
}

export async function runPrintMode(options: RunPrintModeOptions): Promise<PrintModeRun> {
  const live = isLive(options);
  const isolateGlobals = options.isolateGlobals ?? !live;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const ownsCwd = options.cwd == null;
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "subagents-print-"));

  const prevCwd = process.cwd();
  process.chdir(cwd);

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  let hermeticDir: string | undefined;
  if (isolateGlobals) {
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-print-home-"));
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;
  }

  let faux: ReturnType<typeof registerFauxProvider> | undefined;
  let model: Model<string> | undefined;
  let modelRuntime: unknown;
  if (live) {
    const pin = options.live || undefined;
    const provider = pin?.provider ?? process.env.PI_PROVIDER;
    const modelId = pin?.model ?? process.env.PI_MODEL;
    if (provider && modelId) {
      model = (getModel as (p: string, m: string) => Model<string> | undefined)(provider, modelId);
      if (!model) {
        throw new Error(
          `runPrintMode (live mode): model "${provider}/${modelId}" not found in the builtin catalog`,
        );
      }
    }
    modelRuntime = undefined;
  } else {
    if (!options.steps && !options.respond) {
      throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
    }
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    model = faux.getModel();
    ({ modelRuntime } = fauxModelBackend(model));

    if (options.steps) {
      faux.setResponses(options.steps);
    } else {
      const respond = options.respond;
      if (!respond) {
        throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
      }
      const max = options.maxModelCalls ?? 16;
      const factory: FauxResponseStep = async (context, _opts, state) =>
        toAssistantMessage(await respond(context, state));
      faux.setResponses(Array.from({ length: max }, () => factory));
    }
  }

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [EXTENSION_PATH],
    systemPromptOverride: () => options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  await options.beforeRun?.();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: modelRuntime as any,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: live
      ? SettingsManager.create(cwd, agentDir)
      : SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  session.setSessionName("print-mode-host");

  await session.bindExtensions({});

  const manager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as
    | ManagerHandle
    | undefined;

  const hold = options.hold ?? true;
  if (hold && manager) {
    const agent = (session as any).agent;
    if (agent?.dequeueFollowUpMessages) {
      const original = agent.dequeueFollowUpMessages.bind(agent);
      agent.dequeueFollowUpMessages = function patched() {
        const messages = original();
        if (messages.length > 0) return messages;
        if (manager.hasRunning()) {
          return manager.waitForAll().then(() => original());
        }
        return messages;
      };
    }
  }

  let responseText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") responseText = "";
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  const onAbort = () => session.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const dispose = async () => {
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
    }
    try {
      session.dispose?.();
    } catch {
    }
    faux?.unregister();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    try {
      process.chdir(prevCwd);
    } catch {
    }
    if (isolateGlobals) {
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (hermeticDir) rmSync(hermeticDir, { recursive: true, force: true });
    }
    if (ownsCwd) rmSync(cwd, { recursive: true, force: true });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const stillRunning = manager?.hasRunning() ? " (background subagents still running)" : "";
      reject(new Error(`print-mode runner timed out after ${timeoutMs}ms${stillRunning}`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await session.prompt(options.prompt);
        if (hold) {
          while (!failed && manager?.hasRunning()) {
            await manager.waitForAll();
            if (failed) break;
            await session.prompt("Background agents have completed. Process their results.");
          }
        }
      })(),
      timeout,
    ]);
  } catch (err) {
    failed = true;
    try {
      session.abort();
    } catch {
    }
    try {
      await dispose();
    } catch {
    }
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (!responseText.trim()) {
    responseText = lastAssistantText(session);
  }

  const subagents = snapshotSubagents(manager);

  return {
    responseText: responseText.trim(),
    parentSession: session,
    manager,
    subagents,
    modelCalls: faux?.state.callCount ?? 0,
    dispose,
  };
}

export function agentToolResults(session: AgentSession): string[] {
  return toolResultsNamed(session, "agent");
}

export function toolResultsNamed(session: AgentSession, toolName: string): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "toolResult") continue;
    if ((msg as { toolName?: string }).toolName !== toolName) continue;
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("");
    out.push(text);
  }
  return out;
}

export function conversationText(session: AgentSession): string {
  const parts: string[] = [];
  for (const msg of session.messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function invokedToolNames(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string }>) {
      if (block.type === "toolCall" && block.name) out.push(block.name);
    }
  }
  return out;
}

export function agentToolCalls(session: AgentSession): Array<Record<string, unknown>> {
  return toolCallsNamed(session, "agent");
}

export function toolCallsNamed(
  session: AgentSession,
  toolName: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
      if (block.type === "toolCall" && block.name === toolName) {
        out.push((block.arguments ?? {}) as Record<string, unknown>);
      }
    }
  }
  return out;
}

function lastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function snapshotSubagents(manager: ManagerHandle | undefined): Array<Record<string, unknown>> {
  if (!manager) return [];
  const m = manager as unknown as { listAgents?: () => Array<Record<string, unknown>> };
  try {
    return m.listAgents ? m.listAgents() : [];
  } catch {
    return [];
  }
}
