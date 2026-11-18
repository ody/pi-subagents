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
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
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
  return { pi, lifecycle, busHandlers };
}

function ctx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const callsFor = (mock: ReturnType<typeof vi.fn>, name: string): any[][] =>
  mock.mock.calls.filter((call: any[]) => call[0] === name);

describe("a stop while queued reaches the lifecycle events", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-queued-stop-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-queued-stop-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
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

  it("emits agent:failed once and appends one agent:record", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx(tmpDir));
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const spawn = async (requestId: string) => {
      await busHandlers.get("agent:rpc:spawn")!({
        requestId,
        type: "general-purpose",
        prompt: "go",
        options: { description: requestId, isBackground: true },
      });
      return pi.events.emit.mock.calls.find((c: any[]) => c[0] === `agent:rpc:spawn:reply:${requestId}`)![1].data.id;
    };
    await spawn("holder");
    const queuedId = await spawn("queued");
    expect(callsFor(pi.events.emit, "agent:failed")).toHaveLength(0);

    await busHandlers.get("agent:rpc:stop")!({ requestId: "stop", agentId: queuedId });

    const failed = callsFor(pi.events.emit, "agent:failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ id: queuedId, status: "stopped", stopCause: "extension" });
    const records = callsFor(pi.appendEntry, "agent:record");
    expect(records).toHaveLength(1);
    expect(records[0][1]).toMatchObject({ id: queuedId, status: "stopped" });
    expect(callsFor(pi.events.emit, "agent:completed")).toHaveLength(0);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    await lifecycle.get("session_shutdown")();
  });
});
