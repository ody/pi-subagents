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
  createEventBus,
  DefaultResourceLoader,
  type EventBus,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxModelBackend } from "./faux-model-backend.js";
import { getModel, registerFauxProvider } from "./pi-ai.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

function requestWaitIdle(bus: EventBus): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const unsub = bus.on(`agent:rpc:wait_idle:reply:${requestId}`, (reply) => {
      unsub();
      const { success, error } = reply as { success: boolean; error?: string };
      if (success) resolve();
      else reject(new Error(error ?? "wait_idle failed"));
    });
    bus.emit("agent:rpc:wait_idle", { requestId });
  });
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
  onBus?: (bus: EventBus) => void;
  isolateGlobals?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  live?: { provider: string; model: string } | false;
}

export interface PrintModeRun {
  responseText: string;
  parentSession: AgentSession;
  bus: EventBus;
  waitIdle(): Promise<void>;
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

function ignoreErrors(action: () => unknown): void {
  try {
    action();
  } catch {
    return;
  }
}

async function ignoreErrorsAsync(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
}

interface Workspace {
  cwd: string;
  restore: () => void;
}

function enterWorkspace(options: RunPrintModeOptions, isolateGlobals: boolean): Workspace {
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

  const restore = () => {
    ignoreErrors(() => process.chdir(prevCwd));
    if (isolateGlobals) {
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (hermeticDir) rmSync(hermeticDir, { recursive: true, force: true });
    }
    if (ownsCwd) rmSync(cwd, { recursive: true, force: true });
  };
  return { cwd, restore };
}

interface ModelSetup {
  faux?: ReturnType<typeof registerFauxProvider>;
  model?: Model<string>;
  modelRuntime: unknown;
}

function liveModelSetup(options: RunPrintModeOptions): ModelSetup {
  const pin = options.live || undefined;
  const provider = pin?.provider ?? process.env.PI_PROVIDER;
  const modelId = pin?.model ?? process.env.PI_MODEL;
  if (!provider || !modelId) return { modelRuntime: undefined };
  const model = (getModel as (p: string, m: string) => Model<string> | undefined)(provider, modelId);
  if (!model) {
    throw new Error(`runPrintMode (live mode): model "${provider}/${modelId}" not found in the builtin catalog`);
  }
  return { model, modelRuntime: undefined };
}

function fauxModelSetup(options: RunPrintModeOptions): ModelSetup {
  const { steps, respond } = options;
  if (!steps && !respond) {
    throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
  }
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const model = faux.getModel();
  const { modelRuntime } = fauxModelBackend(model);
  if (steps) {
    faux.setResponses(steps);
  } else if (respond) {
    const factory: FauxResponseStep = async (context, _opts, state) =>
      toAssistantMessage(await respond(context, state));
    faux.setResponses(Array.from({ length: options.maxModelCalls ?? 16 }, () => factory));
  }
  return { faux, model, modelRuntime };
}

function trackRunningAgents(bus: EventBus): Set<string> {
  const running = new Set<string>();
  bus.on("agent:started", (data) => { running.add((data as { id: string }).id); });
  const onSettle = (data: unknown) => { running.delete((data as { id: string }).id); };
  bus.on("agent:completed", onSettle);
  bus.on("agent:failed", onSettle);
  return running;
}

async function createHostSession(
  options: RunPrintModeOptions,
  live: boolean,
  host: { cwd: string; agentDir: string; bus: EventBus },
  setup: ModelSetup,
): Promise<AgentSession> {
  const { cwd, agentDir, bus } = host;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    eventBus: bus,
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
    model: setup.model,
    modelRuntime: setup.modelRuntime as any,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: live
      ? SettingsManager.create(cwd, agentDir)
      : SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  session.setSessionName("print-mode-host");
  await session.bindExtensions({});
  return session;
}

function holdForBackgroundAgents(session: AgentSession, running: Set<string>, waitIdle: () => Promise<void>): void {
  const agent = (session as any).agent;
  if (!agent?.dequeueFollowUpMessages) return;
  const original = agent.dequeueFollowUpMessages.bind(agent);
  agent.dequeueFollowUpMessages = function patched() {
    const messages = original();
    if (messages.length > 0) return messages;
    if (running.size > 0) return waitIdle().then(() => original());
    return messages;
  };
}

function captureResponseText(session: AgentSession): { current: () => string; stop: () => void } {
  let responseText = "";
  const stop = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") responseText = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      responseText += event.assistantMessageEvent.delta;
    }
  });
  return { current: () => responseText, stop };
}

function timeoutAfter(ms: number, running: Set<string>): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const stillRunning = running.size > 0 ? " (background subagents still running)" : "";
      reject(new Error(`print-mode runner timed out after ${ms}ms${stillRunning}`));
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

interface PromptLoop {
  session: AgentSession;
  prompt: string;
  hold: boolean;
  running: Set<string>;
  waitIdle: () => Promise<void>;
  state: { failed: boolean };
}

async function promptUntilIdle({ session, prompt, hold, running, waitIdle, state }: PromptLoop): Promise<void> {
  await session.prompt(prompt);
  if (!hold) return;
  while (!state.failed && running.size > 0) {
    await waitIdle();
    if (state.failed) break;
    await session.prompt("Background agents have completed. Process their results.");
  }
}

async function abortAndDispose(session: AgentSession, dispose: () => Promise<void>): Promise<void> {
  ignoreErrors(() => session.abort());
  await ignoreErrorsAsync(dispose);
}

async function disposeSession(session: AgentSession, faux: ModelSetup["faux"], workspace: Workspace): Promise<void> {
  await ignoreErrorsAsync(() => session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }));
  ignoreErrors(() => session.dispose?.());
  faux?.unregister();
  workspace.restore();
}

export async function runPrintMode(options: RunPrintModeOptions): Promise<PrintModeRun> {
  const live = isLive(options);
  const isolateGlobals = options.isolateGlobals ?? !live;
  const workspace = enterWorkspace(options, isolateGlobals);
  const setup = live ? liveModelSetup(options) : fauxModelSetup(options);

  const agentDir = getAgentDir();
  const bus = createEventBus();
  const running = trackRunningAgents(bus);
  options.onBus?.(bus);

  const session = await createHostSession(options, live, { cwd: workspace.cwd, agentDir, bus }, setup);
  const waitIdle = () => requestWaitIdle(bus);
  const hold = options.hold ?? true;
  if (hold) holdForBackgroundAgents(session, running, waitIdle);

  const response = captureResponseText(session);
  const onAbort = () => session.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const dispose = () => disposeSession(session, setup.faux, workspace);
  const state = { failed: false };
  const timeout = timeoutAfter(options.timeoutMs ?? 30_000, running);
  try {
    await Promise.race([
      promptUntilIdle({ session, prompt: options.prompt, hold, running, waitIdle, state }),
      timeout.promise,
    ]);
  } catch (err) {
    state.failed = true;
    await abortAndDispose(session, dispose);
    throw err;
  } finally {
    timeout.clear();
    response.stop();
    options.signal?.removeEventListener("abort", onAbort);
  }

  return {
    responseText: (response.current().trim() ? response.current() : lastAssistantText(session)).trim(),
    parentSession: session,
    bus,
    waitIdle,
    modelCalls: setup.faux?.state.callCount ?? 0,
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
