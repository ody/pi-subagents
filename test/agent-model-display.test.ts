import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { registerAgents } from "../src/agents/agent-types.js";
import subagentsExtension from "../src/index.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        MODELS.find(m => m.provider === provider && m.id === id)),
      getAvailable: vi.fn(() => MODELS),
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function session(provider: string, id: string, thinkingLevel: string, name?: string) {
  return { model: { provider, id, name: name ?? MODEL_NAMES[id] }, thinkingLevel, dispose: vi.fn() } as never;
}

const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

const MODEL_NAMES: Record<string, string> = Object.fromEntries(MODELS.map(m => [m.id, m.name]));

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

function render(tool: any, result: any, expanded = false): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded, isPartial: false },
    theme,
    { isError: false },
  ).render(200).join("\n");
}

function pinnedAgent(frontmatter: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pinned.md"), `---\ndescription: pins its own settings\n${frontmatter}---\n\nPinned.\n`);
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "agent-model-display-"));
  process.chdir(cwd);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Agent tool result — effective model", () => {
  it("names the model even when the child inherited the parent's", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-1",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.modelName).toBe("opus 4.6");
    expect(render(tool, result)).toContain("opus 4.6");
    expect(render(tool, result, true)).toContain("opus 4.6");
  });

  it("names the inherited model while streaming, before a session exists", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      options.onToolActivity?.({ type: "start", toolName: "Read" });
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();
    const onUpdate = vi.fn();

    await tool.execute(
      "tc-1b",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      onUpdate,
      ctx(),
    );

    const streamed = onUpdate.mock.calls[0][0];
    expect(streamed.details.modelName).toBe("opus 4.6");
    expect(tool.renderResult(streamed, { expanded: false, isPartial: true }, theme, { isError: false })
      .render(200).join("\n")).toContain("opus 4.6");
  });

  it("keeps the twin label beside the model", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-2",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("twin");
    expect(render(tool, result)).toContain("twin");
  });

  it("reports the session's level, and what was asked for, when pi clamps it", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-haiku-4-5", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-3",
      { prompt: "go", description: "d", subagent_type: "general-purpose", thinking: "max", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: high (asked max)");
  });

  it("discloses a level an agent file pinned over the caller's (#182)", async () => {
    pinnedAgent("thinking: low\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-4",
      { prompt: "go", description: "d", subagent_type: "pinned", thinking: "max", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: low (asked max)");
  });

  it("runs a caller's model over an agent file's pin, and discloses the pin", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5",
      {
        prompt: "go",
        description: "d",
        subagent_type: "pinned",
        model: "anthropic/claude-opus-4-6",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.modelName).toBe("opus 4.6 (over pinned anthropic/claude-haiku-4-5)");
  });

  it("keeps the disclosure suffix out of the text the model reads", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5d",
      {
        prompt: "go",
        description: "d",
        subagent_type: "pinned",
        model: "anthropic/claude-opus-4-6",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );

    const text = result.content.map((c: any) => c.text ?? "").join("\n");
    expect(text).not.toContain("over pinned");
    expect(text).not.toContain("asked");
  });

  it("never advertises the pin override in the Agent tool schema", async () => {
    const tool = agentTool();
    const description = tool.parameters.properties.model.description as string;

    expect(description).toBe(
      'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). '
        + "Only set this when the user named a model in their request; otherwise omit.",
    );
    expect(`${tool.description}\n${description}`).not.toMatch(/pin|frontmatter|override.*agent file/i);
  });

  it("stays quiet when the caller's spelling names the model that won", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5b",
      { prompt: "go", description: "d", subagent_type: "pinned", model: "haiku", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.modelName).toBe("haiku 4.5");
  });

  it("refuses a caller spelling that names no available model, pin or no pin", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    const run = vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    run.mockClear();

    const result = await tool.execute(
      "tc-5c",
      { prompt: "go", description: "d", subagent_type: "pinned", model: "gpt-9", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.content.map((c: any) => c.text ?? "").join("\n")).toContain("gpt-9");
    expect(run).not.toHaveBeenCalled();
  });

  it("says nothing about a request that was honored", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-6",
      { prompt: "go", description: "d", subagent_type: "general-purpose", thinking: "high", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: high");
    expect(render(tool, result)).not.toContain("asked");
  });
});

describe("Agent tool result — resume", () => {
  it("renders the reopened session's settings, not the resume call's", async () => {
    const s = session("anthropic", "claude-haiku-4-5", "low");
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(s);
      return { responseText: "first", session: s, aborted: false, steered: false } as never;
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" } as never);
    const tool = agentTool();
    const context = ctx();

    const first = await tool.execute(
      "tc-7",
      { prompt: "go", description: "original", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      context,
    );

    const resumed = await tool.execute(
      "tc-8",
      {
        prompt: "continue",
        description: "changed",
        subagent_type: "general-purpose",
        run_in_background: false,
        model: "anthropic/claude-opus-4-6",
        thinking: "max",
        resume: first.details.agentId,
      },
      undefined,
      vi.fn(),
      context,
    );

    expect(resumed.details.modelName).toBe("haiku 4.5");
    expect(resumed.details.tags).toContain("thinking: low");
    expect(render(tool, resumed)).not.toContain("opus 4.6");
  });
});
