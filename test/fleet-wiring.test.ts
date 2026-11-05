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
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
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

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }));
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

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(uiCtx()),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush();

    const fleetRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined);
  });
});
