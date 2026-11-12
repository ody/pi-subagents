import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { getAllTypes, getAvailableTypes, NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agents/agent-types.js";
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

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeAgents(): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scout.md"), "---\ndescription: Scout\ntools: read\n---\nScout.\n");
  writeFileSync(join(dir, "retired.md"), "---\ndescription: Retired\ntools: read\nenabled: false\n---\nRetired.\n");
}

function ctx() {
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

const textOf = (r: any): string => r.content[0].text;

describe("fallbackSubagent gates dispatch through the real agent tool", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "fallback-wiring-"));
    writeAgents();
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    setFallbackSubagent(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  function boot() {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  for (const background of [false, true]) {
    it(`refuses an unknown type without spawning (run_in_background: ${background})`, async () => {
      const { tools } = boot();
      setFallbackSubagent(NO_FALLBACK);

      const result = await tools.get("agent").execute(
        "tc-1",
        {
          prompt: "do it",
          description: "typo dispatch",
          subagent_type: "definitely-missing",
          run_in_background: background,
        },
        undefined, undefined, ctx(),
      );

      expect(textOf(result)).toContain('Unknown or disabled agent type: "definitely-missing"');
      expect(textOf(result)).toContain("scout");
      expect(runAgent).not.toHaveBeenCalled();
    });
  }

  it("still falls back — and says so — when the setting is unset", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false,
    });

    const result = await tools.get("agent").execute(
      "tc-2",
      { prompt: "do it", description: "typo dispatch", subagent_type: "definitely-missing" },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain('Note: Unknown agent type "definitely-missing"');
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(), "general-purpose", "do it", expect.anything(),
    );
  });

  it("carries the fallback note on the background branch too", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);

    const result = await tools.get("agent").execute(
      "tc-3",
      {
        prompt: "do it",
        description: "typo dispatch",
        subagent_type: "definitely-missing",
        run_in_background: true,
      },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain('Note: Unknown agent type "definitely-missing"');
    expect(textOf(result)).toContain("started in background");
  });

  it("refuses a disabled type, which used to dispatch with a mixed identity", async () => {
    const { tools } = boot();
    setFallbackSubagent(NO_FALLBACK);
    expect(getAllTypes()).toContain("retired");
    expect(getAvailableTypes()).not.toContain("retired");

    const result = await tools.get("agent").execute(
      "tc-4",
      { prompt: "do it", description: "disabled dispatch", subagent_type: "retired" },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain("Unknown or disabled agent type");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("never persists a blank type into a scheduled job", async () => {
    const { tools, lifecycle } = boot();
    await lifecycle.get("session_start")({}, ctx());

    const result = await tools.get("agent").execute(
      "tc-5",
      { prompt: "later", description: "blank type", subagent_type: "   ", schedule: "+1h" },
      undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain("Scheduled");

    const storeDir = join(cwd, ".pi", "subagent-schedules");
    const jobs = readdirSync(storeDir).flatMap((f) =>
      JSON.parse(readFileSync(join(storeDir, f), "utf-8")).jobs ?? [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].subagent_type).toBe("general-purpose");
  });

  it("never blocks resume, which ignores subagent_type entirely", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false,
    });
    const spawned = await tools.get("agent").execute(
      "tc-6",
      { prompt: "start", description: "live agent", subagent_type: "scout", run_in_background: false },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1]
      ?? (spawned as any).details?.agentId;
    expect(id).toBeTruthy();

    setFallbackSubagent(NO_FALLBACK);
    const resumed = await tools.get("agent").execute(
      "tc-7",
      { resume: id, prompt: "keep going", description: "resume", subagent_type: "deleted-since" },
      undefined, undefined, ctx(),
    );

    expect(textOf(resumed)).not.toContain("Unknown or disabled agent type");
  });

  it("applies the same contract to cross-extension spawns", async () => {
    boot();
    setFallbackSubagent(NO_FALLBACK);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];

    expect(() => registry.spawn({}, ctx(), "definitely-missing", "do it", { description: "rpc" }))
      .toThrow(/Unknown or disabled agent type/);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
