import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runAgent } from "../src/session/agent-runner.js";
import { tapManager } from "./harness/manager-tap.js";

const RPC_CHANNELS = ["agent:rpc:ping", "agent:rpc:spawn", "agent:rpc:stop", "agent:rpc:consume", "agent:rpc:wait_idle"] as const;

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

  describe("error codes from shared spawn code", () => {
    async function spawnReply(options: object, type = "general-purpose") {
      mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".pi", "agents", "general-purpose.md"),
        "---\ndescription: general-purpose\n---\n\nYou are general-purpose.",
      );
      const { pi, lifecycle, busHandlers } = makePi();
      subagentsExtension(pi);
      await lifecycle.get("session_start")({}, ctx());
      const reply = vi.fn();
      pi.events.on("agent:rpc:spawn:reply:req-1", reply);
      await busHandlers.get("agent:rpc:spawn")!({ requestId: "req-1", type, prompt: "go", options });
      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      return reply.mock.calls[0][0];
    }

    it("replies unknown_type for a type that resolves to no agent", async () => {
      expect(await spawnReply({}, "no-such-agent")).toMatchObject({ success: false, code: "unknown_type" });
    });

    it("replies invalid_cwd for a relative cwd", async () => {
      expect(await spawnReply({ cwd: "relative/dir" })).toMatchObject({ success: false, code: "invalid_cwd" });
    });

    it("replies policy_denied when the policy refuses a tool", async () => {
      writeFileSync(
        join(tmpDir, ".pi", "subagents.json"),
        JSON.stringify({ policy: { tools: { deny: ["bash"] } } }),
      );
      const reply = await spawnReply({ agentConfig: { systemPrompt: "p", builtinToolNames: ["bash"] } });
      expect(reply).toMatchObject({ success: false, code: "policy_denied" });
    });
  });

  describe("agent:rpc:wait_idle", () => {
    async function startSession() {
      mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".pi", "agents", "general-purpose.md"),
        "---\ndescription: general-purpose\n---\n\nYou are general-purpose.",
      );
      const harness = makePi();
      subagentsExtension(harness.pi);
      await harness.lifecycle.get("session_start")({}, ctx());
      return harness;
    }

    function request(h: ReturnType<typeof makePi>, channel: string, payload: object) {
      const reply = vi.fn();
      h.pi.events.on(`${channel}:reply:req`, reply);
      h.busHandlers.get(channel)!({ requestId: "req", ...payload });
      return reply;
    }

    it("replies at once when no agent is running", async () => {
      const h = await startSession();
      const reply = request(h, "agent:rpc:wait_idle", {});
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
    });

    it("replies success only after every top-level agent settles", async () => {
      const h = await startSession();
      const finish: Array<(v: unknown) => void> = [];
      vi.mocked(runAgent).mockImplementation(
        () => new Promise((resolve) => { finish.push(resolve); }) as any,
      );
      for (const id of ["a", "b"]) {
        const spawned = request(h, "agent:rpc:spawn", { type: "general-purpose", prompt: "go", options: { description: id, isBackground: true } });
        await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
      }
      await vi.waitFor(() => expect(finish).toHaveLength(2));

      const reply = request(h, "agent:rpc:wait_idle", {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reply).not.toHaveBeenCalled();

      const result = (text: string) => ({ responseText: text, session: { dispose: vi.fn() }, aborted: false, steered: false });
      finish[0](result("one"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reply).not.toHaveBeenCalled();

      finish[1](result("two"));
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
    });

    it("waits for a nested agent that outlives its top-level parent", async () => {
      const tap = tapManager();
      try {
        const h = await startSession();
        const finish: Array<(v: unknown) => void> = [];
        vi.mocked(runAgent).mockImplementation(
          () => new Promise((resolve) => { finish.push(resolve); }) as any,
        );
        const spawned = request(h, "agent:rpc:spawn", { type: "general-purpose", prompt: "go", options: { description: "parent", isBackground: true } });
        await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
        await vi.waitFor(() => expect(finish).toHaveLength(1));
        const parentId = (spawned.mock.calls[0][0] as { data: { id: string } }).data.id;
        const capability = (vi.mocked(runAgent).mock.calls[0][3] as any).capability;
        tap.manager().spawn(h.pi, ctx(), "general-purpose", "child", { description: "child", isBackground: true, parentAgentId: parentId, capability });
        await vi.waitFor(() => expect(finish).toHaveLength(2));

        const result = (text: string) => ({ responseText: text, session: { dispose: vi.fn() }, aborted: false, steered: false });
        finish[0](result("parent"));
        const reply = request(h, "agent:rpc:wait_idle", {});
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(reply).not.toHaveBeenCalled();

        finish[1](result("child"));
        await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
      } finally {
        tap.restore();
      }
    });

    it("replies code shutdown when session_shutdown comes first", async () => {
      const h = await startSession();
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
      const spawned = request(h, "agent:rpc:spawn", { type: "general-purpose", prompt: "go", options: { description: "a", isBackground: true } });
      await vi.waitFor(() => expect(spawned).toHaveBeenCalled());

      const reply = request(h, "agent:rpc:wait_idle", {});
      await h.lifecycle.get("session_shutdown")({}, ctx());

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply.mock.calls[0][0]).toMatchObject({ success: false, code: "shutdown" });
    });
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

describe("RPC contract: docs/rpc.md lists every agent: name", () => {
  it("names each agent: string literal in src/", () => {
    const src = join(__dirname, "..", "src");
    const doc = readFileSync(join(__dirname, "..", "docs", "rpc.md"), "utf8");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const names = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(join(src, file), "utf8").matchAll(/["'`](agent:[a-z_:]+)/g)) names.add(match[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });
});
