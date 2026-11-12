import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/platform/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/platform/output-file.js")>("../src/platform/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import subagentsExtension from "../src/index.js";
import { ensureOutputFile, streamToOutputFile, writeInitialEntry } from "../src/platform/output-file.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const emitted: { event: string; payload: any }[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn((event: string, payload: any) => { emitted.push({ event, payload }); }),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, emitted };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return String(content ?? result?.text ?? JSON.stringify(result));
}

function agentIdOf(result: any): string {
  const id = /Agent ID: (\S+)/.exec(resultText(result))?.[1];
  if (!id) throw new Error(`no agent id in result: ${JSON.stringify(result)}`);
  return id;
}

describe("agent tool — background resume wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let session: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-bg-resume-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bg-resume-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    process.chdir(cwd);

    session = {
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "tool result" },
      ],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as any);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function spawnSettled(tools: Map<string, any>, ctx: any, type = "general-purpose") {
    const res = await tools.get("agent").execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: type, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    const id = agentIdOf(res);
    await new Promise((r) => setTimeout(r, 0));
    return id;
  }

  it("does not tie the detached run to the tool-call signal", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    let runSignal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation((_s: any, _p: any, opts: any) => {
      runSignal = opts.signal;
      return new Promise(() => {});
    });

    const toolAbort = new AbortController();
    await tools.get("agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true },
      toolAbort.signal,
      undefined,
      ctx,
    );

    expect(runSignal).toBeDefined();
    expect(runSignal!.aborted).toBe(false);

    toolAbort.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(runSignal!.aborted).toBe(false);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("appends to the agent's existing transcript instead of truncating it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(writeInitialEntry).mockClear();
    vi.mocked(streamToOutputFile).mockClear();

    await tools.get("agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );

    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(ensureOutputFile).toHaveBeenCalled();

    expect(streamToOutputFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamToOutputFile).mock.calls[0][4]).toBe(3);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("reports the record's own type, not the caller's ignored subagent_type", async () => {
    writeFileSync(join(agentDir, "agents", "explorer.md"), `---\ndescription: Explorer agent\n---\n\nExplore.`);
    const { pi, tools, lifecycle, emitted } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx, "general-purpose");

    emitted.length = 0;
    const res = await tools.get("agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Different description", subagent_type: "explorer", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );

    const created = emitted.find(e => e.event === "subagents:created");
    expect(created).toBeDefined();
    expect(created!.payload.type).toBe("general-purpose");
    expect(created!.payload.id).toBe(id);
    expect(resultText(res)).toContain("Type: general-purpose");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("refuses a second background resume while the first run is in flight", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();

    const params = { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true };
    await tools.get("agent").execute("resume-1", params, undefined, undefined, ctx);
    const second = await tools.get("agent").execute("resume-2", params, undefined, undefined, ctx);

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    const text = resultText(second);
    expect(text).toContain("still running");
    expect(text).toContain("steer_subagent");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("still resumes in the foreground when run_in_background is false", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(resumeAgent).mockResolvedValue({ text: "inline answer" } as any);
    const res = await tools.get("agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    expect(resultText(res)).toContain("inline answer");
    expect(resultText(res)).not.toContain("You will be notified");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
