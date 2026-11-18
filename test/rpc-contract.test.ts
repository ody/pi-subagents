import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

const RPC_CHANNELS = ["agent:rpc:ping", "agent:rpc:spawn", "agent:rpc:stop", "agent:rpc:consume"] as const;

function makePi() {
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const emitted: string[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn((event: string, payload: unknown) => {
        emitted.push(event);
        const handler = busHandlers.get(event);
        if (handler) handler(payload);
      }),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        return () => busHandlers.delete(event);
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, busHandlers, emitted };
}

function ctx() {
  return {
    hasUI: false,
    ui: {},
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("RPC contract: availability events", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-contract-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-contract-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 3 }));
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

  it("emits nothing on the bus before session_start", () => {
    const { pi, emitted } = makePi();

    subagentsExtension(pi);

    expect(emitted).toEqual([]);
  });

  it("emits agent:ready, then agent:settings_loaded with the settings, on session_start", async () => {
    const { pi, lifecycle, emitted } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    expect(emitted.filter((e) => e === "agent:ready" || e === "agent:settings_loaded")).toEqual([
      "agent:ready",
      "agent:settings_loaded",
    ]);
    expect(pi.events.emit).toHaveBeenCalledWith("agent:settings_loaded", {
      settings: { maxConcurrent: 3 },
      policy: expect.objectContaining({ ephemeralNesting: true }),
    });
  });

  it("registers handlers again after session_shutdown and a new session_start", async () => {
    const { pi, lifecycle, busHandlers, emitted } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    for (const channel of RPC_CHANNELS) expect(busHandlers.has(channel)).toBe(true);

    await lifecycle.get("session_shutdown")({}, ctx());
    for (const channel of RPC_CHANNELS) expect(busHandlers.has(channel)).toBe(false);

    await lifecycle.get("session_start")({}, ctx());
    for (const channel of RPC_CHANNELS) expect(busHandlers.has(channel)).toBe(true);
    expect(emitted.filter((e) => e === "agent:ready")).toHaveLength(2);
    expect(emitted.filter((e) => e === "agent:settings_loaded")).toHaveLength(2);
  });

  it("does not register or emit again on a second session_start without a shutdown", async () => {
    const { pi, lifecycle, emitted } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());

    expect(emitted.filter((e) => e === "agent:ready")).toHaveLength(1);
    expect(emitted.filter((e) => e === "agent:settings_loaded")).toHaveLength(1);
  });
});
