/**
 * rpc-inline-agent.test.ts — an RPC spawn carrying its agent definition inline.
 *
 * Drives the real extension factory, so the whole spawn funnel
 * (`spawnTopLevel` → `spawnResolved` → manager → `runAgent`) is exercised. The
 * claims: an inline config skips type resolution (so `fallbackSubagent: none`
 * cannot reject it, and no fallback can replace it), it reaches `runAgent`
 * intact, and it never enters the agent registry the `Agent` tool and
 * `/agents` read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { getAllTypes, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

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

function ctx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
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

describe("subagents:rpc:spawn with an inline agentConfig", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-inline-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-inline-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // Strict dispatch: an unknown type would be refused, so a success below
    // proves the inline path never consulted the registry.
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, fallbackSubagent: "none" }),
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
    setFallbackSubagent(undefined);
    vi.restoreAllMocks();
  });

  it("runs the inline definition under its own name and keeps it out of the registry", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const requestId = "req-inline";
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "advisor",
      prompt: "review",
      options: {
        description: "Advisor review",
        agentConfig: { systemPrompt: "You are the advisor.", builtinToolNames: [], extensions: false, skills: false, maxTurns: 1 },
      },
    });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`,
    );
    expect(reply![1].success, `spawn succeeded, got: ${JSON.stringify(reply![1])}`).toBe(true);

    const [, type, prompt, options] = vi.mocked(runAgent).mock.lastCall!;
    expect(type).toBe("advisor");
    expect(prompt).toBe("review");
    expect(options.maxTurns).toBe(1);
    expect(options.agentConfig).toMatchObject({
      name: "advisor",
      systemPrompt: "You are the advisor.",
      builtinToolNames: [],
      extensions: false,
      skills: false,
    });
    expect(getAllTypes()).not.toContain("advisor");
  });
});
