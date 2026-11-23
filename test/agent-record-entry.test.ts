import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { fauxModelBackend } from "./harness/faux-model-backend.js";
import { registerFauxProvider } from "./harness/pi-ai.js";

const captured = vi.hoisted(() => ({ settle: undefined as ((record: AgentRecord) => void) | undefined }));

vi.mock("../src/manager/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/manager/agent-manager.js")>("../src/manager/agent-manager.js");
  return {
    ...actual,
    AgentManager: class extends actual.AgentManager {
      constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
        super(...args);
        captured.settle = args[0];
      }
    },
  };
});

import subagentsExtension from "../src/index.js";

function boot() {
  const pi = {
    registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(), on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  };
  subagentsExtension(pi as never);
  return pi;
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-id", type: "inline", description: "work", status: "completed",
    result: "done", startedAt: 1, completedAt: 2, handle: "inline-1", alias: "audit",
    agentConfig: { name: "inline", description: "work", systemPrompt: "secret" },
    resultConsumed: true, lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, ...overrides,
  } as AgentRecord;
}

describe("agent:record entry", () => {
  it("writes persisted session fields and stop cause", () => {
    const pi = boot();
    const agent = record({ sessionFile: "/sessions/agent.jsonl", status: "stopped", stopCause: "extension" });
    captured.settle!(agent);
    expect(pi.appendEntry).toHaveBeenCalledWith("agent:record", expect.objectContaining({
      id: agent.id, status: "stopped", stopCause: "extension", handle: agent.handle,
      alias: agent.alias, sessionFile: agent.sessionFile, agentConfig: agent.agentConfig,
    }));
  });

  it("does not invent a config for a registered agent", () => {
    const pi = boot();
    captured.settle!(record({ type: "registered", agentConfig: undefined, sessionFile: "/sessions/registered.jsonl" }));
    const entry = pi.appendEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(entry).toMatchObject({ handle: "inline-1", sessionFile: "/sessions/registered.jsonl" });
    expect(entry.agentConfig).toBeUndefined();
  });

  it("omits session fields without a session file", () => {
    const pi = boot();
    captured.settle!(record({ sessionFile: undefined, stopCause: "user" }));
    const entry = pi.appendEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.stopCause).toBe("user");
    for (const key of ["handle", "alias", "sessionFile", "agentConfig"]) expect(entry).not.toHaveProperty(key);
  });

  it("does not write nested agents", () => {
    const pi = boot();
    captured.settle!(record({ parentAgentId: "parent", sessionFile: "/sessions/child.jsonl" }));
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("record entries from real sessions", () => {
  let cwd: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "record-entry-"));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = cwd;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.chdir(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  });

  afterEach(() => {
    faux.unregister();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    { setting: false, frontmatter: "", label: "rememberAgents: false" },
    { setting: true, frontmatter: "persist_session: false\n", label: "persist_session: false" },
  ])("omits gated fields with $label", async ({ setting, frontmatter }) => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ rememberAgents: setting, scopeModels: false }));
    writeFileSync(join(cwd, ".pi", "agents", "probe.md"), `---\ndescription: probe\nextensions: false\nskills: false\n${frontmatter}---\nprobe`);
    const handlers = new Map<string, (data: unknown, ctx?: unknown) => unknown>();
    const bus = new Map<string, (data: unknown) => unknown>();
    const pi = {
      registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
      on: vi.fn((name: string, handler: (data: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler)),
      events: { emit: vi.fn(), on: vi.fn((name: string, handler: (data: unknown) => unknown) => { bus.set(name, handler); return vi.fn(); }) },
      appendEntry: vi.fn(), sendMessage: vi.fn(), exec: vi.fn(),
    };
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx = {
      cwd, hasUI: false, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      model, modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getSessionId: () => "parent", getBranch: () => [] }, getSystemPrompt: () => "parent",
    };
    subagentsExtension(pi as never);
    await handlers.get("session_start")!({}, ctx);
    await bus.get("agent:rpc:spawn")!({ requestId: "spawn", type: "probe", prompt: "go", options: { name: "audit" } });
    await vi.waitFor(() => expect(pi.appendEntry).toHaveBeenCalled());
    const entry = pi.appendEntry.mock.calls[0][1] as Record<string, unknown>;
    expect(entry.status).toBe("completed");
    for (const key of ["handle", "alias", "sessionFile", "agentConfig"]) expect(entry).not.toHaveProperty(key);
    await handlers.get("session_shutdown")!({}, ctx);
  }, 30_000);
});
