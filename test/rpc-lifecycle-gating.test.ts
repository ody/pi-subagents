import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runAgent } from "../src/session/agent-runner.js";

const RPC_CHANNELS = ["subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop"] as const;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, busHandlers };
}

function ctx(hasUI = false, setWidget = vi.fn()) {
  return {
    hasUI,
    ui: {
      setStatus: vi.fn(),
      setWidget,
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const readyEmits = (pi: any): unknown[] =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:ready");
const onCallsFor = (pi: any, channel: string): unknown[] =>
  pi.events.on.mock.calls.filter((c: any[]) => c[0] === channel);

describe("issue #142: RPC handlers + subagents:ready are gated on session_start", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-142-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-142-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({}));
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "agents", "general-purpose.md"),
      "---\ndescription: general-purpose\n---\n\nYou are general-purpose.",
    );
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT advertise or register RPC at factory time (the filtered-out case)", () => {
    const { pi, busHandlers } = makePi();

    subagentsExtension(pi);

    expect(readyEmits(pi), "no subagents:ready before session_start").toHaveLength(0);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} must not be registered at factory time`).toBe(false);
    }
  });

  it("advertises and registers RPC on session_start, and spawn works once bound", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    expect(readyEmits(pi), "subagents:ready fires once bound").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} registered on session_start`).toBe(true);
    }

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const requestId = "req-142";
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc gating test" },
    });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`,
    );
    expect(reply, "spawn emitted a reply").toBeTruthy();
    expect(reply![1].success, `spawn succeeded, got: ${JSON.stringify(reply![1])}`).toBe(true);
    expect(reply![1].data.id).toBeTruthy();
  });

  it("renders an RPC-spawned agent in the native widget while it is running", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    const activeCtx = ctx(true);
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, activeCtx);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-widget",
        type: "general-purpose",
        prompt: "go",
        options: { description: "visible RPC agent" },
      });

      await vi.waitFor(() => {
        expect(activeCtx.ui.setWidget).toHaveBeenCalledWith(
          "agents",
          expect.any(Function),
          { placement: "aboveEditor" },
        );
        expect(activeCtx.ui.setStatus).toHaveBeenCalledWith("subagents", "1 running agent");
      });
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("shows live tool activity for an RPC-spawned background agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    let widgetFactory: any;
    const setWidget = vi.fn((key: string, content: any) => {
      if (key === "agents" && content) widgetFactory = content;
    });
    const extensionCtx = ctx(true, setWidget);
    let onToolActivity: ((activity: { type: "start" | "end"; toolName: string }) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      onToolActivity = options.onToolActivity;
      options.onSessionCreated?.({ subscribe: () => vi.fn() });
      return new Promise(() => {}) as any;
    });
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, extensionCtx);
    await lifecycle.get("tool_execution_start")({}, extensionCtx);
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId: "req-activity",
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc activity test", isBackground: true },
    });
    await vi.waitFor(() => expect(onToolActivity).toBeTypeOf("function"));
    onToolActivity!({ type: "start", toolName: "bash" });

    expect(widgetFactory).toBeTypeOf("function");
    const lines = widgetFactory(
      { terminal: { columns: 120 }, requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    ).render().join("\n");
    expect(lines).toContain("running command…");
    expect(lines).not.toContain("thinking…");
  });

  it("is idempotent — a second session_start does not re-advertise or double-register", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());

    expect(readyEmits(pi), "subagents:ready emitted exactly once across two session_starts").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(onCallsFor(pi, channel), `${channel} registered exactly once`).toHaveLength(1);
    }
  });
});
