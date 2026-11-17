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

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function uiCtx() {
  const unsubscribe = vi.fn();
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => unsubscribe),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
    unsubscribe,
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const DOWN = "\x1b[B";
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("Agents widget selection wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-select-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-select-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ defaultJoinMode: "async" }));
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "agents", "general-purpose.md"), "---\ndescription: General purpose\n---\n\nYou are general-purpose.");
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

  async function spawnLive(ui: ReturnType<typeof uiCtx>) {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    await tools.get("agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    await flush();
    const onInput = (ui.onTerminalInput.mock.calls[0] as unknown as [(data: string) => unknown])[0];
    return { onInput, lifecycle };
  }

  it("captures terminal input on tool_execution_start", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("selects a row in the Agents widget on \u2193 and registers no other widget", async () => {
    const ui = uiCtx();
    const fakeTui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } };
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    let component: { render(): string[] } | undefined;
    ui.setWidget.mockImplementation(((_key: string, content: unknown) => {
      if (typeof content === "function") component = content(fakeTui, theme);
    }) as any);
    const { onInput } = await spawnLive(ui);

    expect(component?.render()[0]).toContain("\u2193 to manage");
    expect(onInput(DOWN)).toEqual({ consume: true });
    expect(component?.render().some((line) => line.includes("\u25b8") && line.includes("live one"))).toBe(true);

    const keys = new Set(ui.setWidget.mock.calls.filter((c) => typeof c[1] === "function").map((c) => c[0]));
    expect([...keys]).toEqual(["agents"]);
    expect(ui.setWidget.mock.calls.every((c) => c[0] === "agents" && (c[1] === undefined || (c[2] as { placement?: string }).placement === "aboveEditor"))).toBe(true);
  });

  it("does not select while another component has focus", async () => {
    const ui = uiCtx();
    const fakeTui = { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 }, focusedComponent: { kind: "selector" } };
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    ui.setWidget.mockImplementation(((_key: string, content: unknown) => {
      if (typeof content === "function") content(fakeTui, theme);
    }) as any);
    const { onInput } = await spawnLive(ui);

    expect(ui.setWidget.mock.calls.some((c) => c[0] === "agents" && typeof c[1] === "function")).toBe(true);
    expect(onInput(DOWN)).toBeUndefined();
  });

  it("stops listening and clears the widget on shutdown", async () => {
    const ui = uiCtx();
    const { lifecycle } = await spawnLive(ui);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.unsubscribe).toHaveBeenCalled();
    expect(ui.setWidget).toHaveBeenCalledWith("agents", undefined);
  });

  it("listens again when the session restarts on the same UI", async () => {
    const ui = uiCtx();
    const { lifecycle } = await spawnLive(ui);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalledTimes(2);
  });
});
