import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  sessionManagerCreate,
  sessionManagerOpen,
  settingsManagerCreate,
  settingsManagerGetSessionDir,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  loaderExtensionsRef: {
    current: { extensions: [], errors: [], runtime: {} } as {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
      runtime: Record<string, unknown>;
    },
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  sessionManagerCreate: vi.fn(() => ({ kind: "persistent-session-manager" })),
  sessionManagerOpen: vi.fn(() => ({ kind: "reopened-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  defineTool: (definition: unknown) => definition,
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      if (this.opts.noExtensions) {
        loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
        return;
      }
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate, open: sessionManagerOpen },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agents/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/platform/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/session/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/session/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

vi.mock("../src/tool/nested-tools.js", () => ({
  getMaxSubagentDepth: vi.fn(() => 2),
  createNestedSubagentTools: vi.fn(() => [
    { name: "agent" },
    { name: "get_subagent_result" },
    { name: "steer_subagent" },
    { name: "stop_subagent" },
  ]),
}));

import {
  getDefaultMaxTurns,
  getGraceTurns,
  resolveEffectiveMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "../src/config/runner-defaults.js";
import {
  type RunOptions,
  resolveDefaultModel,
  resumeAgent,
  runAgent as runAgentWithCapability,
} from "../src/session/agent-runner.js";
import { SUBAGENT_TOOL_NAMES } from "../src/session/extension-scope.js";
import { buildAgentPrompt } from "../src/session/prompts.js";
import { grant } from "./helpers/capability.js";

function runAgent(ctx: any, type: string, prompt: string, options: Omit<RunOptions, "capability"> & Partial<Pick<RunOptions, "capability">>) {
  if (options.agentConfig) {
    return runAgentWithCapability(ctx, type, prompt, { capability: grant(options.agentConfig, { isolated: options.isolated }), ...options });
  }
  const registered = getAgentConfig(type);
  const display = getConfig(type);
  const declared = {
    ...registered,
    builtinToolNames: getToolNamesForType(type),
    extensions: display.extensions,
    excludeExtensions: display.excludeExtensions,
    skills: display.skills,
  };
  return runAgentWithCapability(ctx, type, prompt, { capability: grant(declared, { isolated: options.isolated }), agentConfig: registered, ...options });
}

let lastSession: ReturnType<typeof createSession>["session"] | undefined;

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  let activeToolNames: string[] = ["read", "bash", "edit", "write"];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
    }),
    getAllTools: vi.fn(() => {
      const opts = createAgentSession.mock.calls[0]?.[0];
      return opts ? mockRegistry(opts).map((name) => ({ name })) : [];
    }),
    agent: { beforeToolCall: undefined } as {
      beforeToolCall?: (context: any, signal?: any) => Promise<any>;
    },
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  lastSession = session;
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
  },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockClear();
  sessionManagerOpen.mockClear();
  setRememberAgents(true);
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  vi.mocked(createNestedSubagentTools).mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
  lastSession = undefined;
});

describe("agent-runner inline agentConfig", () => {
  const inline = {
    name: "advisor",
    description: "Reviews the executor's work",
    systemPrompt: "You are the advisor.",
    builtinToolNames: [] as string[],
    extensions: false as const,
    skills: false as const,
    promptMode: "replace" as const,
    maxTurns: 1,
  };

  it("builds the prompt from the inline config and gives the child no tools", async () => {
    const { session } = createSession("ADVICE");
    createAgentSession.mockResolvedValue({ session });
    vi.mocked(getAgentConfig).mockClear();
    vi.mocked(getConfig).mockClear();
    vi.mocked(getToolNamesForType).mockClear();

    const result = await runAgent(ctx, "advisor", "Review this", { pi, agentConfig: inline });

    expect(result.responseText).toBe("ADVICE");
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![0]).toBe(inline);
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toEqual([]);
    expect(opts.customTools).toEqual([]);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noExtensions: true, noSkills: true }),
    );
    expect(session.setSessionName).toHaveBeenCalledWith("advisor");
    expect(getAgentConfig).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(getToolNamesForType).not.toHaveBeenCalled();
  });

  it("takes the turn limit from the inline config", () => {
    expect(resolveEffectiveMaxTurns("advisor", undefined, inline)).toBe(1);
  });
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp/worktree", undefined, expect.anything());
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("forwards worktreeBase to the prompt builder, and omits it otherwise", async () => {
    const { buildAgentPrompt } = await import("../src/session/prompts.js");
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi, cwd: "/wt/copy", worktreeBase: "/repo" });
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![4]).toMatchObject({ worktreeBase: "/repo" });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![4]).not.toHaveProperty("worktreeBase");
  });

  it("passes the parent model runtime while retaining the legacy model registry", async () => {
    const { session } = createSession("AUTHENTICATED");
    createAgentSession.mockResolvedValue({ session });
    const modelRuntime = { getAuth: vi.fn(), hasConfiguredAuth: vi.fn() };
    const context = {
      ...ctx,
      modelRegistry: { ...ctx.modelRegistry, runtime: modelRuntime },
    };

    await runAgent(context, "Explore", "Say AUTHENTICATED", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      modelRegistry: context.modelRegistry,
      modelRuntime,
    }));
  });

  it("omits modelRuntime when the legacy registry does not expose one", async () => {
    const { session } = createSession("LEGACY");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LEGACY", { pi });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRuntime");
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result.text).toBe("RESUMED");
    expect(result.failure).toBeUndefined();
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore#a1b2c3d4");
  });
});

describe("agent-runner failed-final-turn detection (#144)", () => {
  function sessionEnding(...messages: any[]) {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(...messages);
    }) as any;
    return session;
  }

  const errorFinal = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "retries exhausted: 529 overloaded",
  };

  it("flags a run whose final turn is an empty provider error", async () => {
    const session = sessionEnding(errorFinal);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("flags the failure even when an EARLIER turn produced text (no masking)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "partial progress" }] },
      { role: "toolResult", content: [] },
      errorFinal,
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.responseText).toBe("partial progress");
  });

  it("flags a provider error that left partial text in the SAME final message", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated answ" }],
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("stream ended before message_stop");
    expect(result.responseText).toBe("truncated answ");
  });

  it("flags a run whose final turn hit the token limit with no text (#144 residual)", async () => {
    const session = sessionEnding({ role: "assistant", content: [], stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("run hit the output token limit before producing any text");
  });

  it("does NOT flag a length stop that produced text (truncated answer completes)", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("truncated but useful answer");
  });

  it("does NOT flag an empty final turn that stopped cleanly (no false failures)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "did the work" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [], stopReason: "stop" },
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("did the work");
  });

  it("resumeAgent applies the same rule", async () => {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "Continue");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("resume whose new turn fails empty does NOT return the previous turn's answer (#144)", async () => {
    const { session } = createSession("");
    session.messages.push(
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "follow-up");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("");
  });

  it("resume that produces partial text before failing returns only THIS resume's text", async () => {
    const { session } = createSession("");
    session.messages.push(
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "new partial" }] },
        { role: "toolResult", content: [] },
        errorFinal,
      );
    }) as any;

    const result = await resumeAgent(session as any, "go");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("new partial");
  });

  it("collector: a toolResult/user message_start no longer wipes collected assistant text", async () => {
    const { session, listeners } = createSession("");
    createAgentSession.mockResolvedValue({ session });
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start", message: { role: "assistant" } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STREAMED" } });
        l({ type: "message_start", message: { role: "toolResult" } });
        l({ type: "message_start", message: { role: "user" } });
      }
    }) as any;

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.responseText).toBe("STREAMED");
  });
});

describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number; cost?: number }> = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: { total: 0.002 } });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: { total: 0.004 } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.002 },
      { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.004 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5, cacheRead: 90, cost: { total: 0.001 } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5, cacheRead: 90, cost: 0.001 }]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
} from "../src/agents/agent-types.js";
import { createNestedSubagentTools } from "../src/tool/nested-tools.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    promptMode: "replace" as const,
    ...overrides,
  };
}

function withExtensions(spec: Record<string, string[]>) {
  loaderExtensionsRef.current = {
    extensions: Object.entries(spec).map(([path, tools]) => ({
      path,
      tools: new Map(tools.map((n) => [n, {}])),
    })),
    errors: [],
    runtime: {},
  };
}

function mockRegistry(opts: Record<string, any>): string[] {
  const excluded = new Set<string>(opts.excludeTools ?? []);
  const customNames: string[] = (opts.customTools ?? []).map((t: any) => t.name);
  const all: string[] = opts.tools
    ? [...opts.tools, ...customNames]
    : [
        ...BUILTINS_7,
        ...loaderExtensionsRef.current.extensions.flatMap((e) => [...e.tools.keys()]),
        ...customNames,
      ];
  return [...new Set(all)].filter((t) => !excluded.has(t));
}

function lastToolsPassed(): string[] {
  const opts = createAgentSession.mock.calls[0][0];
  if (opts.tools) return opts.tools;
  return lastSession?.getActiveToolNames() ?? [];
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

describe("agent-runner session persistence", () => {
  it("persists by default, so a handle can reopen the conversation later", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("keeps the session in memory when rememberAgents is off", async () => {
    setRememberAgents(false);
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("lets frontmatter override rememberAgents in both directions", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: false }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(sessionManagerInMemory).toHaveBeenCalled();
    expect(sessionManagerCreate).not.toHaveBeenCalled();

    sessionManagerInMemory.mockClear();
    setRememberAgents(false);
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
  });

  it("leaves a nested child in memory, since nothing can address it later", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });

    await runAgent(ctx, "Explore", "go", { pi, nested: true });

    expect(sessionManagerInMemory).toHaveBeenCalled();
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("still persists a nested child that asks for it in frontmatter", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });

    await runAgent(ctx, "Explore", "go", { pi, nested: true });

    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
  });

  it("reopens an existing session file instead of starting a new conversation", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "carry on", { pi, resumeSessionFile: "/sessions/explore.jsonl" });

    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerOpen).toHaveBeenCalledWith("/sessions/explore.jsonl", "/normal/pi/sessions");
  });

  it("uses pi's normal persistent session location and links to the parent session", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/tmp",
      "/normal/pi/sessions",
      { parentSession: "/sessions/parent.jsonl" },
    );
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("uses a frontmatter sessionDir when persistSession is true and sessionDir is configured", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ persistSession: true, sessionDir: ".seams/pi-sessions/seam-plan-reviewer" }),
    );
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/repo",
      "/repo/.seams/pi-sessions/seam-plan-reviewer",
      { parentSession: "/sessions/parent.jsonl" },
    );
  });
});

describe("agent-runner master tool allowlist", () => {
  it("extensions: true with extension tools — all 7 built-ins plus extension tools land in the allowlist", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toHaveLength(BUILTINS_7.length + 2);
    expect(new Set(tools)).toEqual(new Set([...BUILTINS_7, "mcp", "mcp_call"]));
  });

  it("enumerates tools across multiple loaded extensions", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/a.ts": ["tool_a"], "/ext/b.ts": ["tool_b"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
  });

  it("disallowedTools removes both built-ins and extension tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash", "mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).toContain("read");
  });

  it("EXCLUDED_TOOL_NAMES never reach the allowlist even if an extension registers them", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({
      "/ext/evil.ts": ["agent", "get_subagent_result", "steer_subagent", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("agent");
    expect(tools).not.toContain("get_subagent_result");
    expect(tools).not.toContain("steer_subagent");
    expect(tools).toContain("ok_ext");
  });

  it("keeps nested tools unavailable without explicit opt-in", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("agent");
    expect(createAgentSession.mock.calls[0][0].customTools).toEqual([]);
  });

  it("injects scoped nested tools for an opted-in non-isolated agent", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: ["scout"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const manager = {} as any;

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
    });

    expect(createNestedSubagentTools).toHaveBeenCalledWith(expect.objectContaining({
      manager,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: ["scout"],
      configCwd: "/tmp",
    }));
    expect(lastToolsPassed()).toEqual(expect.arrayContaining([
      "agent", "get_subagent_result", "steer_subagent", "stop_subagent",
    ]));
    expect(createAgentSession.mock.calls[0][0].customTools).toHaveLength(4);
  });

  it("keeps opt-in nested tools active UNDER EXTENSIONS despite the EXCLUDED-name collision", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/ok.ts": ["ok_ext"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.excludeTools ?? []).not.toContain("agent");
    expect(opts.customTools).toHaveLength(4);
    const active = lastToolsPassed();
    expect(active).toEqual(expect.arrayContaining(["agent", "get_subagent_result", "steer_subagent", "stop_subagent"]));
    expect(active).toContain("ok_ext");
  });

  describe("disallowed_tools beats opt-in nested delegation", () => {
    it("denies the tool under the isolated static allowlist", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: false, allowedSubagents: "all", disallowedTools: ["agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      const tools = lastToolsPassed();
      expect(tools).not.toContain("agent");
      expect(tools).toEqual(expect.arrayContaining(["get_subagent_result", "steer_subagent"]));
    });

    it("denies the tool at the registry gate under extensions", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: true, allowedSubagents: "all", disallowedTools: ["agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      withExtensions({ "/ext/ok.ts": ["ok_ext"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      expect(createAgentSession.mock.calls[0][0].excludeTools ?? []).toContain("agent");
      expect(lastToolsPassed()).not.toContain("agent");
    });

    it("blocks the tool at runtime even though it was injected as a customTool", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: true, allowedSubagents: "all", disallowedTools: ["agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      withExtensions({ "/ext/ok.ts": ["ok_ext"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      await expect(
        session.agent.beforeToolCall?.({ toolCall: { name: "agent" } }),
      ).resolves.toMatchObject({ block: true });
      await expect(
        session.agent.beforeToolCall?.({ toolCall: { name: "steer_subagent" } }),
      ).resolves.not.toMatchObject({ block: true });
    });

    it("a partial denial does not take down the whole nested set", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({
          extensions: false,
          allowedSubagents: ["scout"],
          disallowedTools: ["get_subagent_result"],
        }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
      });

      const tools = lastToolsPassed();
      expect(tools).not.toContain("get_subagent_result");
      expect(tools).toContain("agent");
      expect(tools).toContain("steer_subagent");
    });
  });

  it("still strips the orchestration tools under extensions when nesting is OFF", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/evil.ts": ["agent", "get_subagent_result", "steer_subagent", "ok_ext"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const active = lastToolsPassed();
    expect(active).not.toContain("agent");
    expect(active).not.toContain("get_subagent_result");
    expect(active).not.toContain("steer_subagent");
    expect(active).toContain("ok_ext");
  });

  it("suppresses nested tools in isolated mode even when opted in", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      isolated: true,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("agent");
  });

  it("passes the inherited depth cap through to the nested tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
    });
    expect(createNestedSubagentTools).toHaveBeenLastCalledWith(expect.objectContaining({ maxSubagentDepth: 3 }));
  });

  it("injects no nested tools once the effective cap is reached", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("agent");
  });

  it("extensions: false with disallowedTools — denylist applies to built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).toEqual(BUILTINS_7.filter((t) => t !== "bash"));
  });

  it("dynamic mode: leaves the allowlist unset, denies via excludeTools, activates post-bind", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toBeUndefined();
    expect(new Set(opts.excludeTools)).toEqual(
      new Set([...Object.values(SUBAGENT_TOOL_NAMES), "bash"]),
    );

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    const setOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeGreaterThan(bindOrder);
    const activated = new Set(session.setActiveToolsByName.mock.calls[0][0]);
    expect(activated.has("mcp")).toBe(true);
    expect(activated.has("read")).toBe(true);
    expect(activated.has("bash")).toBe(false);
  });
});

describe("agent-runner async extension tool registration", () => {
  function registerLate(extPath: string, toolName: string) {
    const ext = loaderExtensionsRef.current.extensions.find((e) => e.path === extPath);
    if (!ext) throw new Error(`no loaded extension at ${extPath}`);
    ext.tools.set(toolName, {});
  }

  function setup(o: { builtinToolNames?: string[]; extSelectors?: string[] } = {}) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, extSelectors: o.extSelectors }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames ?? ["read"]);
  }

  it("a tool registered during session_start reaches the active set", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    session.bindExtensions.mockImplementation(async () => {
      registerLate("/ext/mcp.ts", "mcp_search");
    });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastToolsPassed()).toContain("mcp_search");
  });

  it("a tool registered after bind is picked up on the next turn_end", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    expect(session.getActiveToolNames()).not.toContain("mcp_search");

    registerLate("/ext/mcp.ts", "mcp_search");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("mcp_search");
  });

  it("ext: admits a late tool from the selected extension but not from others", async () => {
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    const active = session.getActiveToolNames();
    expect(active).toContain("foo_late");
    expect(active).not.toContain("bar_late");
  });

  it("ext:foo/bar narrowing still applies to late-registered siblings", async () => {
    setup({ extSelectors: ["ext:foo/keep_me"] });
    withExtensions({ "/ext/foo.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "keep_me");
    registerLate("/ext/foo.ts", "drop_me");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("keep_me");
    expect(session.getActiveToolNames()).not.toContain("drop_me");
  });

  it("a verdict that denies an extension keeps its late tools out", async () => {
    setup({});
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const policy = { global: { tools: { deny: ["ext:foo"] } }, project: {}, ephemeralNesting: true, problems: [] };

    await runAgent(ctx, "Explore", "go", { pi, capability: grant({ builtinToolNames: ["read"] }, { policy }) });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("bar_late");
    expect(session.getActiveToolNames()).not.toContain("foo_late");
  });

  it("a verdict with no extension tools keeps every late extension tool out", async () => {
    setup({});
    withExtensions({ "/ext/foo.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const policy = { global: { tools: { allow: ["read"] } }, project: {}, ephemeralNesting: true, problems: [] };

    await runAgent(ctx, "Explore", "go", { pi, capability: grant({ builtinToolNames: ["read"] }, { policy }) });

    registerLate("/ext/foo.ts", "foo_late");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).not.toContain("foo_late");
  });

  it("beforeToolCall blocks an out-of-scope tool and delegates otherwise", async () => {
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/bar.ts": ["bar_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_tool" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } }),
    ).resolves.toBeUndefined();
  });

  it("beforeToolCall preserves a hook pi installed before us", async () => {
    setup();
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    const prior = vi.fn(async () => undefined);
    session.agent.beforeToolCall = prior;
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } });

    expect(prior).toHaveBeenCalledTimes(1);
  });

  it("scope outlives runAgent so resumed turns stay narrowed", async () => {
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await resumeAgent(session as any, "keep going");

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("foo_late");
    expect(session.getActiveToolNames()).not.toContain("bar_late");
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } }),
    ).resolves.toMatchObject({ block: true });
  });

  it("isolated keeps the static allowlist — no live scoping installed", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read"]);
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    expect(createAgentSession.mock.calls[0][0].tools).toEqual(["read"]);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.agent.beforeToolCall).toBeUndefined();
  });
});

describe("agent-runner extension allowlist", () => {
  function setupArrayAgent(extensions: string[]) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  it("['*'] short-circuits — no extensionsOverride, behaves like extensions: true", async () => {
    setupArrayAgent(["*"]);
    withExtensions({ "/ext/a.ts": ["tool_a"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.extensionsOverride).toBeUndefined();
    expect(opts.additionalExtensionPaths).toBeUndefined();
    expect(lastToolsPassed()).toContain("tool_a");
  });

  it("['mcp'] keeps only the mcp-named extension, drops others", async () => {
    setupArrayAgent(["mcp"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp", "mcp_call"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).not.toContain("other_tool");
  });

  it("matches a package-installed extension by its package short name, not just its src dir (#143)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-match-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@ody/pi-subagents", pi: { extensions: ["./src/index.ts"] } }),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
      const entry = join(dir, "src", "index.ts");

      setupArrayAgent(["pi-subagents"]);
      withExtensions({ [entry]: ["pkg_tool"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      expect(lastToolsPassed()).toContain("pkg_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an absolute path is added to additionalExtensionPaths and its extension survives", async () => {
    setupArrayAgent(["/abs/foo.ts"]);
    withExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    expect(lastToolsPassed()).toContain("foo_tool");
  });

  it("['*', path] keeps all defaults plus the extra path", async () => {
    setupArrayAgent(["*", "/abs/foo.ts"]);
    withExtensions({
      "/ext/default.ts": ["default_tool"],
      "/abs/foo.ts": ["foo_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("default_tool");
    expect(tools).toContain("foo_tool");
  });

  it("['mcp', path] keeps exactly those two, drops other defaults (no wildcard)", async () => {
    setupArrayAgent(["mcp", "/abs/foo.ts"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/abs/foo.ts": ["foo_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    expect(opts.extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("disallowedTools still applies to tools from an allowlisted extension", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: ["mcp"] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: ["mcp"], disallowedTools: ["mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
  });

  it("warns but proceeds when a bare name matches no loaded extension", async () => {
    setupArrayAgent(["mcp", "typo"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "typo"'),
      }),
    );
  });

  it("warns but proceeds when a path entry fails to load", async () => {
    setupArrayAgent(["/abs/missing.ts"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "missing"'),
      }),
    );
  });

  it("matches `extensions: [Mcp]` against `mcp.ts` (case-insensitive)", async () => {
    setupArrayAgent(["Mcp"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const errorCalls = onToolActivity.mock.calls.filter((c) =>
      typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
    expect(lastToolsPassed()).toContain("mcp_tool");
  });
});

describe("agent-runner exclude_extensions", () => {
  function setupAgent(overrides: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }
  function extensionErrors(onToolActivity: ReturnType<typeof vi.fn>): string[] {
    return onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("extension-error:"));
  }

  it("extensions: true + exclude — override installed, excluded tools dropped, others kept", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("['*'] + exclude — wildcard no longer short-circuits, exclusion applies", async () => {
    setupAgent({ extensions: ["*"], excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
  });

  it("allowlist + exclude of a listed name — subtracted, 'in both' warning fires", async () => {
    setupAgent({ extensions: ["mcp", "other"], excludeExtensions: ["other"] });
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).not.toContain("other_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('in both extensions: and exclude_extensions:'),
    ]);
  });

  it("exclude typo — warning fires, all extensions still load", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["nope"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('exclude_extensions: "nope"'),
    ]);
  });

  it("extensions: false + exclude — orphan warning, no override", async () => {
    setupAgent({ extensions: false, excludeExtensions: ["notify"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("exclude_extensions has no effect"),
    ]);
  });

  it("isolated: true + exclude — excludes nulled, no warnings", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({ "/ext/notify.ts": ["notify_send"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity, isolated: true });

    expect(lastToolsPassed()).not.toContain("notify_send");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("tools: ext:foo referencing an excluded extension — existing orphan warning fires", async () => {
    setupAgent({
      extensions: true,
      excludeExtensions: ["beta"],
      extSelectors: ["ext:beta"],
    });
    withExtensions({
      "/ext/beta.ts": ["beta_tool"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("beta_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("extension-error:ext:beta"),
    ]);
  });

  it("exclude matches case-insensitively", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["MCP"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });
});

describe("agent-runner unknown built-in tools", () => {
  it("emits a tools-error warning for each plain entry not in BUILTIN_TOOL_NAMES", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "reed", "grep", "edt"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "reed", "grep", "edt"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toHaveLength(2);
    expect(errorMessages.some((m) => m.includes('"reed"'))).toBe(true);
    expect(errorMessages.some((m) => m.includes('"edt"'))).toBe(true);
  });

  it("stays quiet when all plain tool names are valid built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "grep"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "grep"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toEqual([]);
  });
});

describe("agent-runner ext: tool selectors", () => {
  function setupExtAgent(o: {
    extensions: boolean | string[];
    builtinToolNames: string[];
    extSelectors?: string[];
    disallowedTools?: string[];
  }) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: o.extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({
        extensions: o.extensions,
        extSelectors: o.extSelectors,
        disallowedTools: o.disallowedTools,
      }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames);
  }

  it("any ext: entry flips extension tools to an allowlist — non-selected extensions muted", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
    expect(tools).not.toContain("read");
    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
  });

  it("'*' alongside ext: keeps all built-ins while the flip still applies", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: BUILTINS_7, extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    for (const b of BUILTINS_7) expect(tools).toContain(b);
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("ext:foo/bar narrows foo to a single tool", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
  });

  it("ext:foo is orphaned when extensions: false — no extension loads, warning fires", async () => {
    setupExtAgent({ extensions: false, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().noExtensions).toBe(true);
    const tools = lastToolsPassed();
    expect(tools).toEqual(["read"]);
    expect(tools).not.toContain("foo_tool");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
  });

  it("ext: cannot pull an extension that `extensions: [...]` excludes — warns, no surfacing", async () => {
    setupExtAgent({ extensions: ["a"], builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/a.ts": ["a_tool"], "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("foo_tool");
    expect(tools).not.toContain("a_tool");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
  });

  it("['*'] short-circuit survives ext: narrowing", async () => {
    setupExtAgent({ extensions: ["*"], builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
    const tools = lastToolsPassed();
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
    expect(tools).not.toContain("other_tool");
  });

  it("warns but proceeds when an ext: name doesn't match any loaded extension", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:ghost"] });
    withExtensions({ "/ext/real.ts": ["real_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:ghost'),
      }),
    );
  });

  it("isolated: true ignores extSelectors — no extension tools", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
    expect(lastLoaderOpts().noExtensions).toBe(true);
  });

  it("ext: composes with a path-loaded extension via its canonical name", async () => {
    setupExtAgent({
      extensions: ["/abs/foo.ts"],
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
    });
    withExtensions({ "/abs/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).toContain("read");
    expect(tools).not.toContain("other_tool");
    const errorCalls = onToolActivity.mock.calls.filter(
      (c) => typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
  });

  it("ext:foo/Bar narrowing is case-sensitive on the tool half", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/Bar"] });
    withExtensions({ "/ext/foo.ts": ["Bar", "bar"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("Bar");
    expect(tools).not.toContain("bar");
  });

  it("disallowedTools removes a tool reached via an ext: selector", async () => {
    setupExtAgent({
      extensions: true,
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
      disallowedTools: ["foo_tool"],
    });
    withExtensions({ "/ext/foo.ts": ["foo_tool", "foo_other"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("foo_other");
    expect(tools).not.toContain("foo_tool");
  });
});

describe("agent-runner turn limits", () => {
  let prevMax: number | undefined;
  let prevGrace: number;

  beforeEach(() => {
    prevMax = getDefaultMaxTurns();
    prevGrace = getGraceTurns();
  });

  afterEach(() => {
    setDefaultMaxTurns(prevMax);
    setGraceTurns(prevGrace);
  });

  async function runWithTurns(turns: number, options: Record<string, unknown> = {}) {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session, listeners } = createSession("OK");
    session.prompt.mockImplementation(async () => {
      for (let i = 0; i < turns; i++) {
        for (const l of [...listeners]) l({ type: "turn_end" });
      }
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "go", { pi, ...options });
    return { session, result };
  }

  it("does not steer or abort below the limit", async () => {
    const { session, result } = await runWithTurns(3, { maxTurns: 5 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(false);
  });

  it("steers exactly once on reaching the limit, and does not abort", async () => {
    setGraceTurns(5);
    const { session, result } = await runWithTurns(5, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer.mock.calls[0][0]).toContain("turn limit");
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(true);
  });

  it("does not re-steer on every turn once the soft limit latched", async () => {
    setGraceTurns(5);
    const { session } = await runWithTurns(8, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("hard-aborts once the grace turns are used up", async () => {
    setGraceTurns(2);
    const { session, result } = await runWithTurns(7, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it("keeps running through the grace window without aborting", async () => {
    setGraceTurns(3);
    const { session, result } = await runWithTurns(7, { maxTurns: 5 });
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(true);
  });

  it("treats maxTurns 0 as unlimited", async () => {
    const { session } = await runWithTurns(30, { maxTurns: 0 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("is unlimited when nothing configures a limit", async () => {
    setDefaultMaxTurns(undefined);
    const { session } = await runWithTurns(30);
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("falls back to the global default when the call sets no limit", async () => {
    setDefaultMaxTurns(4);
    setGraceTurns(5);
    const { session } = await runWithTurns(4);
    expect(session.steer).toHaveBeenCalledTimes(1);
  });

  it("an explicit maxTurns beats the global default", async () => {
    setDefaultMaxTurns(2);
    setGraceTurns(5);
    const { session } = await runWithTurns(4, { maxTurns: 10 });
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("reports each turn to the caller's counter", async () => {
    const onTurnEnd = vi.fn();
    await runWithTurns(3, { maxTurns: 10, onTurnEnd });
    expect(onTurnEnd.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  });
});

describe("agent-runner abort signal forwarding", () => {
  it("aborts the session when the parent signal fires mid-run", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const controller = new AbortController();
    const { session } = createSession("OK");
    session.prompt.mockImplementation(async () => {
      controller.abort();
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });

    expect(session.abort).toHaveBeenCalled();
  });

  it("removes its listener once the run settles", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    controller.abort();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("registers nothing when no signal is supplied", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe("resolveDefaultModel", () => {
  const parent = { provider: "anthropic", id: "parent-model" } as any;
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" } as any;

  function registry(available?: any[]) {
    return {
      find: vi.fn((provider: string, id: string) => ({ provider, id }) as any),
      getAvailable: available ? () => available : undefined,
    };
  }

  it("returns the configured model when the registry has it available", () => {
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "anthropic/claude-haiku-4-5"))
      .toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("falls back to the parent when the model is NOT in the available set", () => {
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "openai/gpt-5")).toBe(parent);
  });

  it("trusts `find` when the registry cannot enumerate availability", () => {
    const r = registry(undefined);
    expect(resolveDefaultModel(parent, r, "anthropic/claude-haiku-4-5"))
      .toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("falls back to the parent when the registry cannot find the model", () => {
    const r = { find: vi.fn(() => undefined), getAvailable: undefined };
    expect(resolveDefaultModel(parent, r as any, "anthropic/nope")).toBe(parent);
  });

  it("falls back to the parent for a model string with no provider prefix", () => {
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "haiku")).toBe(parent);
    expect(r.find).not.toHaveBeenCalled();
  });

  it("returns the parent model when no model is configured", () => {
    expect(resolveDefaultModel(parent, registry([haiku]), undefined)).toBe(parent);
  });

  it("returns undefined when neither a config model nor a parent model exists", () => {
    expect(resolveDefaultModel(undefined, registry([haiku]), undefined)).toBeUndefined();
  });
});
