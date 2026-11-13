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
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
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

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools.get("agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
    undefined,
    undefined,
    ctx(),
  );
}

describe("backgroundByDefault", () => {
  it("returns an agent ID, not the result, when the call doesn't specify", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools));

    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("still blocks and returns the output inline when run_in_background is false", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools, { run_in_background: false }));

    expect(out).toContain("THE-PAYLOAD");
    expect(out).not.toContain("started in background");
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools)));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });

  it("describes the default as true while the setting is on", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const description = tools.get("agent").parameters.properties.run_in_background.description;

    expect(description).toContain("Defaults to true");
  });
});

describe("backgroundByDefault off", () => {
  let agentDir: string;
  let originalAgentDir: string | undefined;

  const writeFile = (name: string, runInBackground: boolean) =>
    writeFileSync(join(agentDir, "agents", `${name}.md`), `---\ndescription: ${name}\nrun_in_background: ${runInBackground}\n---\n${name}\n`);

  const register = () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    return tools;
  };

  const run = (tools: Map<string, any>, params: Record<string, unknown>) =>
    tools.get("agent").execute(
      "tc",
      { prompt: "go", description: "d", ...params },
      undefined,
      undefined,
      ctx(),
    );

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "bg-default-agent-"));
    mkdirSync(join(agentDir, "agents"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "agents", "general-purpose.md"), "---\ndescription: general\n---\ngeneral\n");
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ backgroundByDefault: false }));
    settled("THE-PAYLOAD");
  });

  afterEach(() => {
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("blocks and returns the output inline when the call does not specify", async () => {
    const out = textOf(await run(register(), { subagent_type: "general-purpose" }));

    expect(out).toContain("THE-PAYLOAD");
    expect(out).not.toContain("Agent ID:");
  });

  it("lets a caller run_in_background of true beat the setting", async () => {
    const out = textOf(await run(register(), { subagent_type: "general-purpose", run_in_background: true }));

    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("lets an agent file run_in_background of true beat the setting", async () => {
    writeFile("detached", true);

    const out = textOf(await run(register(), { subagent_type: "detached" }));

    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("describes the default as false", () => {
    const description = register().get("agent").parameters.properties.run_in_background.description;

    expect(description).toContain("Defaults to false");
    expect(description).not.toContain("Defaults to true");
  });
});

describe("backgroundByDefault on with an agent file", () => {
  it("lets an agent file run_in_background of false beat the setting", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "bg-default-agent-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      mkdirSync(join(agentDir, "agents"));
      writeFileSync(join(agentDir, "agents", "attached.md"), "---\ndescription: attached\nrun_in_background: false\n---\nattached\n");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const { pi, tools } = makePi();
      subagentsExtension(pi);
      settled("THE-PAYLOAD");

      const out = textOf(await spawn(tools, { subagent_type: "attached" }));

      expect(out).toContain("THE-PAYLOAD");
      expect(out).not.toContain("Agent ID:");
    } finally {
      if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
