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

const PAST_THE_HOLD_MS = 400;

function makePi() {
  const lifecycle = new Map<string, any>();
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const bus = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler));
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: bus,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, bus };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const notifications = (pi: any): unknown[] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

describe("subagents:rpc:consume", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-consume-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-consume-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false }),
    );
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function boot() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    return booted;
  }

  async function spawnOverRpc(bus: ReturnType<typeof makePi>["bus"], requestId: string): Promise<string> {
    let id = "";
    bus.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: any) => { id = reply.data.id; });
    bus.emit("subagents:rpc:spawn", {
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "task #1", isBackground: true },
    });
    await vi.waitFor(() => expect(id).toBeTruthy());
    return id;
  }

  it("notifies for an RPC-spawned agent nobody consumed", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    await spawnOverRpc(bus, "req-spawn-1");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toHaveLength(1);
  });

  it("suppresses the notification once the caller consumes the result", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    bus.on("subagents:completed", (data: unknown) => {
      bus.emit("subagents:rpc:consume", { requestId: "req-consume", agentId: (data as { id: string }).id });
    });

    await spawnOverRpc(bus, "req-spawn-2");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toEqual([]);
  });

  it("refuses to consume an agent that is still running", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const { bus } = await boot();

    const id = await spawnOverRpc(bus, "req-spawn-3");
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-running", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-running", agentId: id });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });

  it("reports an unknown agent rather than silently succeeding", async () => {
    const { bus } = await boot();
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-unknown", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-unknown", agentId: "no-such-agent" });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });
});
