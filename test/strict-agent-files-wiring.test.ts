import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  return {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

const BROKEN = "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeSettings(settings: Record<string, unknown>): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subagents.json"), JSON.stringify(settings));
}

function writeBrokenAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "broken.md");
  writeFileSync(path, BROKEN);
  return path;
}

describe("strictAgentFiles gates extension activation", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-agent-files-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("aborts activation naming the file when enabled", () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    expect(() => subagentsExtension(makePi())).toThrow(path);
  });

  it("skips the file and activates when disabled (the default)", () => {
    writeBrokenAgent();

    expect(() => subagentsExtension(makePi())).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0])).toContain("Skipping agent file");
  });

  it("is a startup decision: a later reload of the same file does not throw", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");
    const pi = makePi();
    expect(() => subagentsExtension(pi)).not.toThrow();
    writeFileSync(path, BROKEN);

    const agentTool = (pi.registerTool as any).mock.calls
      .map((c: any[]) => c[0])
      .find((t: any) => t.name === "agent");
    expect(agentTool).toBeDefined();

    const uiCtx = {
      hasUI: false,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    } as any;

    const result = await agentTool.execute("call-1", { subagent_type: "nope", prompt: "x" }, undefined, vi.fn(), uiCtx);
    expect(JSON.stringify(result)).not.toContain("Nested mappings");
  });
});
