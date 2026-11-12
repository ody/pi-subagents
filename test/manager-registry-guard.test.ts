import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runAgent } from "../src/session/agent-runner.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

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
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
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

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
  const r = await tools.get("agent").execute(
    "tc-spawn",
    { prompt: "go", description: "registry test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const priorGlobal = (globalThis as any)[MANAGER_KEY];
afterEach(() => {
  if (priorGlobal === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorGlobal;
  vi.mocked(runAgent).mockReset();
});

describe("Symbol.for manager registry across activations", () => {
  it("child activation does not overwrite the root entry; child shutdown does not delete it", async () => {
    delete (globalThis as any)[MANAGER_KEY];

    const root = makePi();
    subagentsExtension(root.pi);
    const rootEntry = (globalThis as any)[MANAGER_KEY];
    expect(rootEntry).toBeDefined();

    const id = await spawnBackground(root.tools);
    expect(rootEntry.getRecord(id)).toBeDefined();

    const child = makePi();
    subagentsExtension(child.pi);

    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeDefined();

    await child.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);

    await root.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });
});

describe("the registry spawn strips internal capabilities", () => {
  function forge(options: Record<string, unknown>) {
    delete (globalThis as any)[MANAGER_KEY];
    const root = makePi();
    subagentsExtension(root.pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const entry = (globalThis as any)[MANAGER_KEY];
    const id = entry.spawn(root.pi, ctx(), "general-purpose", "go", {
      description: "forged", isBackground: true, ...options,
    });
    return { entry, id, root, runOpts: () => vi.mocked(runAgent).mock.calls[0][3] as any };
  }

  it("refuses a forged nesting, so the agent cannot hide under someone else's id", async () => {
    const { entry, id, root } = forge({ parentAgentId: "victim-agent-id", depth: 9, maxSubagentDepth: 99 });

    expect(entry.getRecord(id)).toMatchObject({
      parentAgentId: undefined, depth: 1, maxSubagentDepth: undefined,
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses a forged transcript directory and config root", async () => {
    const { entry, id, root, runOpts } = forge({ rootSessionId: "../../elsewhere", configCwd: "/etc" });

    expect(entry.getRecord(id).rootSessionId).toBeUndefined();
    expect(runOpts().configCwd).toBeUndefined();
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses a forged session file, which would replay someone else's conversation", async () => {
    const { root, runOpts } = forge({ resumeSessionFile: "/home/victim/.pi/agent/sessions/private.jsonl" });

    expect(runOpts().resumeSessionFile).toBeUndefined();
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses a forged reclaim and allocates a handle the ordinary way", async () => {
    const { entry, id, root } = forge({ reclaim: { handle: "explore", alias: "auth-audit" } });

    expect(entry.getRecord(id)).toMatchObject({ handle: "general-purpose", alias: undefined });
    await root.lifecycle.get("session_shutdown")?.();
  });
});
