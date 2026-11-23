import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agents/agent-types.js";
import { loadCustomAgents } from "../../src/agents/custom-agents.js";
import type * as AgentRunner from "../../src/session/agent-runner.js";
import type { AgentConfig } from "../../src/types.js";
import { GrantingAgentManager } from "../harness/capability.js";
import { fauxModelBackend } from "../harness/faux-model-backend.js";
import { registerFauxProvider } from "../harness/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../../src/platform/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/platform/output-file.js")>("../../src/platform/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn((_cwd: string, agentId: string) => `/tmp/fake-tasks/${agentId}.output`),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import subagentsExtension from "../../src/index.js";
import { createOutputFilePath, writeInitialEntry } from "../../src/platform/output-file.js";
import { createWorktree } from "../../src/platform/worktree.js";
import { resumeAgent, runAgent } from "../../src/session/agent-runner.js";
import { createNestedSubagentTools } from "../../src/tool/nested-tools.js";

const actualRunner = await vi.importActual<typeof AgentRunner>("../../src/session/agent-runner.js");

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []), getAll: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function agentIdOf(result: any): string {
  const text = (result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("\n");
  const id = /Agent ID: (\S+)/.exec(text)?.[1];
  if (!id) throw new Error(`no agent id in result: ${text}`);
  return id;
}

function sessionHeaderId(file: string): string {
  return JSON.parse(readFileSync(file, "utf-8").split("\n")[0]).id;
}

describe("agent id is the pi session id", () => {
  let cwd: string;
  let agentDir: string;
  let sessionDir: string;
  let previous: Record<string, string | undefined>;
  let previousCwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-agent-id-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-agent-id-agent-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-id-sessions-"));
    previousCwd = process.cwd();
    previous = {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
      HOME: process.env.HOME,
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({}));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "general-purpose.md"), "---\ndescription: General purpose\n---\n\nYou are general-purpose.");
    process.chdir(cwd);
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [cwd, agentDir, sessionDir]) rmSync(dir, { recursive: true, force: true });
    vi.mocked(createOutputFilePath).mockClear();
    vi.mocked(writeInitialEntry).mockClear();
  });

  describe("with a real session", () => {
    let faux: ReturnType<typeof registerFauxProvider>;
    let manager: GrantingAgentManager;

    beforeEach(() => {
      faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
      faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText("ok")])));
      vi.mocked(runAgent).mockImplementation(actualRunner.runAgent);
      manager = new GrantingAgentManager();
    });

    afterEach(() => {
      manager.dispose();
      faux.unregister();
    });

    function register(name: string, persistSession: boolean) {
      registerAgents(
        new Map([
          [
            name,
            {
              name,
              description: name,
              builtinToolNames: ["read"],
              extensions: false,
              skills: false,
              systemPrompt: "You are a probe.",
              promptMode: "replace",
              inheritContext: false,
              runInBackground: false,
              isolated: false,
              persistSession,
            } as AgentConfig,
          ],
        ]),
      );
    }

    async function runProbe(name: string) {
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const ctx: any = {
        cwd,
        getSystemPrompt: () => "PARENT",
        model,
        modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      };
      return manager.spawnAndWait({ exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any, ctx, name, "go", {
        description: "probe",
        model,
      });
    }

    it("is a uuidv7", async () => {
      register("probe", false);
      const { id } = await runProbe("probe");
      expect(id).toMatch(UUIDV7);
    });

    it("equals the session id of an in-memory agent", async () => {
      register("memory", false);
      const { id, record } = await runProbe("memory");
      expect(record.error).toBeUndefined();
      expect(record.status).toBe("completed");
      expect(record.session?.sessionId).toBe(id);
      expect(record.session?.sessionFile).toBeUndefined();
    });

    it("equals the session id in the header of a persisted agent's session file", async () => {
      register("kept", true);
      const { id, record } = await runProbe("kept");
      expect(record.status).toBe("completed");
      expect(record.session?.sessionId).toBe(id);
      const file = record.session?.sessionFile as string;
      expect(file).toContain(sessionDir);
      expect(sessionHeaderId(file)).toBe(id);
    });

    it("refuses to replace a held id", async () => {
      register("held", false);
      const { id, record } = await runProbe("held");
      expect(() => manager.spawn({} as any, { cwd } as any, "held", "again", {
        description: "duplicate", sessionId: id,
      })).toThrow(`Agent ${id} already exists`);
      expect(manager.getRecord(id)).toBe(record);
    });

    it("gives two same-type agents started in one minute different session names", async () => {
      register("twin", false);
      const first = await runProbe("twin");
      const second = await runProbe("twin");
      const names = [first, second].map(run => run.record.session?.sessionName);
      expect(names[0]).toBe(`twin#${first.id.slice(-8)}`);
      expect(names[1]).toBe(`twin#${second.id.slice(-8)}`);
      expect(names[0]).not.toBe(names[1]);
    });
  });

  describe("in the .output transcript", () => {
    function mockedSession() {
      return {
        messages: [{ role: "user", content: "first task" }],
        subscribe: vi.fn(() => vi.fn()),
        steer: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as any;
    }

    beforeEach(() => {
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
        await Promise.resolve();
        const session = mockedSession();
        options.onSessionCreated?.(session);
        return { responseText: "done", session, aborted: false, steered: false };
      });
      vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as any);
    });

    function startedIds(): string[] {
      return vi.mocked(runAgent).mock.calls.map(call => (call[3] as { agentId?: string }).agentId as string);
    }

    it("names the file and the agentId field after the id of a top-level start", async () => {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = makeCtx(cwd);

      const result = await tools.get("agent").execute(
        "call",
        { prompt: "work", description: "Work", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
      const id = agentIdOf(result);

      expect(id).toMatch(UUIDV7);
      expect(startedIds()).toEqual([id]);
      expect(createOutputFilePath).toHaveBeenCalledWith(cwd, id, "session-1");
      expect(basename(vi.mocked(createOutputFilePath).mock.results[0].value as string)).toBe(`${id}.output`);
      expect(vi.mocked(writeInitialEntry).mock.calls[0][1]).toBe(id);
      await lifecycle.get("session_shutdown")?.({}, ctx);
    });

    it("keeps the id and the file name for a background resume", async () => {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = makeCtx(cwd);
      const started = await tools.get("agent").execute(
        "call",
        { prompt: "work", description: "Work", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );
      const id = agentIdOf(started);
      await new Promise(resolve => setTimeout(resolve, 0));
      vi.mocked(createOutputFilePath).mockClear();

      const resumed = await tools.get("agent").execute(
        "resume-call",
        { prompt: "more", description: "More", subagent_type: "general-purpose", resume: id, run_in_background: true },
        undefined,
        undefined,
        ctx,
      );

      expect(agentIdOf(resumed)).toBe(id);
      expect(createOutputFilePath).toHaveBeenCalledWith(cwd, id, "session-1");
      expect(basename(vi.mocked(createOutputFilePath).mock.results[0].value as string)).toBe(`${id}.output`);
      await lifecycle.get("session_shutdown")?.({}, ctx);
    });

    it("names the file and the agentId field after the id of a nested start", async () => {
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout\n");
      registerAgents(loadCustomAgents(cwd));
      const manager = new GrantingAgentManager();
      try {
        const { pi } = makePi();
        const parentId = manager.spawn(pi, makeCtx(cwd), "general-purpose", "parent", {
          description: "parent",
          isBackground: true,
          rootSessionId: "root-session",
        });
        const [agent] = createNestedSubagentTools({
          manager,
          pi,
          parentAgentId: parentId,
          depth: 1,
          maxSubagentDepth: 2,
          allowedSubagents: "all",
          configCwd: cwd,
        });

        const result = await (agent as any).execute(
          "call",
          { subagent_type: "scout", description: "traced", prompt: "Do work", run_in_background: true },
          undefined,
          undefined,
          makeCtx(cwd),
        );
        const id = agentIdOf(result);

        expect(id).toMatch(UUIDV7);
        expect(startedIds()).toContain(id);
        expect(createOutputFilePath).toHaveBeenCalledWith(cwd, id, "root-session");
        expect(manager.getRecord(id)?.outputFile).toBe(`/tmp/fake-tasks/${id}.output`);
        expect(vi.mocked(writeInitialEntry).mock.calls.at(-1)?.[1]).toBe(id);
      } finally {
        manager.dispose();
      }
    });
  });

  describe("in the worktree", () => {
    it("names the branch and the path with the full id", async () => {
      const id = "0197a1b2-c3d4-7e5f-8a6b-1234567890ab";
      const root = mkdtempSync(join(tmpdir(), "pi-agent-id-repo-"));
      try {
        const exec = vi.fn(async (_cmd: string, args: string[]) => ({
          code: 0,
          stdout: args[0] === "rev-parse" && args[1] === "--show-toplevel" ? root : "abc123",
          stderr: "",
          killed: false,
        }));

        const info = await createWorktree({ exec } as any, root, id);

        expect(info?.branch).toBe(`pi-agent-${id}`);
        expect(basename(info?.path ?? "")).toMatch(new RegExp(`^pi-agent-${id}-[0-9a-f]{8}$`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
