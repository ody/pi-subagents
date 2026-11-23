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
  const events = new Map<string, any>();
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
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, events };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function spawnCompletedBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Review monero_en.rs in depth", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}

describe("issue #108: unread completed background agents survive session events", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-108-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-108-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({}));
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

  it("session_before_switch (user switches sessions) does NOT wipe the unread result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    await lifecycle.get("session_before_switch")?.();

    const res = await tools.get("agent_get_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(res);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("session_start (/resume) does NOT wipe the unread result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    await lifecycle.get("session_start")?.({}, ctx());

    const res = await tools.get("agent_get_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(res);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("replaces an abandoned completed live record with the active branch entry", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const id = await spawnCompletedBackgroundAgent(tools);
    const recorded = pi.appendEntry.mock.calls.find(([type]: [string]) => type === "agent:record")?.[1];
    expect(recorded?.id).toBe(id);
    context.sessionManager.getBranch.mockReturnValue([{ type: "custom", customType: "agent:record", data: {
      ...recorded, id: "branch-agent", handle: "general-purpose", sessionFile: "/sessions/branch-agent", result: "BRANCH-RESULT",
    } }]);
    await lifecycle.get("session_tree")({}, context);
    const get = (agent_id: string) => tools.get("agent_get_result").execute("read", { agent_id }, undefined, undefined, context);
    expect(textOf(await get(id))).toContain("Agent not found");
    expect(textOf(await get("general-purpose"))).toContain("BRANCH-RESULT");
    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("rebuilds from the active branch on start and tree navigation", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const context = ctx();
    const entry = (id: string) => ({ type: "custom", customType: "agent:record", data: {
      id, handle: id, type: "general-purpose", description: id, sessionFile: `/sessions/${id}`, completedAt: 1, status: "completed", result: id,
    } });
    context.sessionManager.getBranch.mockReturnValue([entry("first")]);
    await lifecycle.get("session_start")({}, context);
    const get = (id: string) => tools.get("agent_get_result").execute("read", { agent_id: id }, undefined, undefined, context);
    expect(textOf(await get("first"))).toContain("first");
    context.sessionManager.getBranch.mockReturnValue([entry("second")]);
    await lifecycle.get("session_tree")({}, context);
    expect(textOf(await get("first"))).toContain("Agent not found");
    expect(textOf(await get("second"))).toContain("second");
    await lifecycle.get("session_shutdown")({}, context);
  });
});
