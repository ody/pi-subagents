import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRegistry, getAvailableTypes, registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import { setScopeModelsEnabled } from "../src/config/model-scope.js";
import { encodeCwd } from "../src/platform/output-file.js";
import { addUsageToAncestors, createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager, resolveNestedModel, resolveNestedType, setMaxSubagentDepth } from "../src/tool/nested-tools.js";
import { grant } from "./helpers/capability.js";

let cwd: string;
let manager: NestedAgentManager;
let records: Map<string, any>;
let spawn: ReturnType<typeof vi.fn>;
let spawnAndWait: ReturnType<typeof vi.fn>;

function writeAgent(name: string, extra = "") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${extra}---\n${name}\n`);
}

const MODELS = [
  { id: "allowed", name: "Allowed", provider: "anthropic" },
  { id: "blocked", name: "Blocked", provider: "anthropic" },
];

function ctx(executionCwd = cwd) {
  return {
    cwd: executionCwd,
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getAvailable: () => MODELS,
      getAll: () => MODELS,
    },
  } as any;
}

function tools(
  allowedSubagents: "all" | string[] = "all",
  depth = 1,
  maxSubagentDepth = 2,
  configCwd = cwd,
) {
  return createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId: "parent-1",
    depth,
    maxSubagentDepth,
    allowedSubagents,
    configCwd,
  });
}

async function execute(tool: any, params: Record<string, unknown>, executionCwd = cwd) {
  return tool.execute("call-1", params, undefined, undefined, ctx(executionCwd));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nested-tools-test-"));
  writeAgent("scout");
  writeAgent("reviewer");
  registerAgents(loadCustomAgents(cwd));
  records = new Map();
  spawn = vi.fn((_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    records.set(id, { id, type, status: "running", parentAgentId: options.parentAgentId });
    return id;
  });
  spawnAndWait = vi.fn(async (_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    const record = { id, type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
    records.set(id, record);
    return { id, record };
  });
  manager = {
    spawn,
    spawnAndWait,
    awaitStartup: vi.fn(async () => {}),
    getRecord: (id: string) => {
      const record = records.get(id);
      if (id !== "parent-1") return record;
      if (record) {
        record.capabilities ??= grant().capabilities;
        return record;
      }
      return { id, capabilities: grant().capabilities };
    },
    resume: vi.fn(),
    abort: vi.fn((id: string) => {
      const record = records.get(id);
      if (!record || (record.status !== "running" && record.status !== "queued")) return false;
      record.status = "stopped";
      return true;
    }),
  } as any;
});

afterEach(() => {
  setScopeModelsEnabled(false);
  rmSync(cwd, { recursive: true, force: true });
});

describe("child-safe nested agent tools", () => {
  it("allows any enabled agent when allowed_subagents is omitted", async () => {
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "reviewer", "Review it",
      expect.objectContaining({
        depth: 2,
        parentAgentId: "parent-1",
        maxSubagentDepth: 2,
        configCwd: cwd,
      }),
      expect.any(Function),
    );
  });

  it("keeps agent discovery rooted in inherited config, not the working directory", async () => {
    const workCwd = mkdtempSync(join(tmpdir(), "nested-tools-work-"));
    const workAgentDir = join(workCwd, ".pi", "agents");
    mkdirSync(workAgentDir, { recursive: true });
    writeFileSync(join(workAgentDir, "intruder.md"), "---\ndescription: intruder\n---\nintruder\n");

    try {
      const [agent] = tools();
      const result = await execute(agent, {
        subagent_type: "intruder",
        description: "untrusted agent",
        prompt: "Do work",
      }, workCwd);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or disabled");
      expect(spawnAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(workCwd, { recursive: true, force: true });
    }
  });

  it("enforces a narrow allowlist", async () => {
    const [limited] = tools(["scout"]);
    const denied = await execute(limited, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not allowed");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const allowed = await execute(limited, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });
    expect(allowed.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
  });

  it("resolves nested types without touching the process-global registry", async () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "nested-tools-config-"));
    const otherAgentDir = join(otherCwd, ".pi", "agents");
    mkdirSync(otherAgentDir, { recursive: true });
    writeFileSync(join(otherAgentDir, "branch-only.md"), "---\ndescription: branch-only\n---\nbranch-only\n");
    const before = getAvailableTypes();

    try {
      const [agent] = tools("all", 1, 2, otherCwd);
      const result = await execute(agent, {
        subagent_type: "branch-only",
        description: "branch agent",
        prompt: "Do work",
      });

      expect(result.isError).toBe(false);
      expect(getAvailableTypes()).toEqual(before);
      expect(getAvailableTypes()).not.toContain("branch-only");
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("applies the scopeModels allowlist to a caller-supplied model", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["anthropic/allowed"] }),
    );
    setScopeModelsEnabled(true);
    const [agent] = tools();

    const blocked = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      model: "anthropic/blocked",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Model not in scope");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const inScope = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      model: "anthropic/allowed",
    });
    expect(inScope.isError).toBe(false);
  });

  it("runs a caller's model over an agent file's pin", async () => {
    writeAgent("pinned", "model: anthropic/blocked\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, { subagent_type: "pinned", description: "d", prompt: "p", model: "anthropic/allowed" });

    expect(spawnAndWait.mock.calls[0][4].model).toMatchObject({ provider: "anthropic", id: "allowed" });
  });

  it("refuses a caller model that does not resolve instead of falling back to the pin", async () => {
    writeAgent("pinned", "model: anthropic/blocked\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    const result = await execute(agent, { subagent_type: "pinned", description: "d", prompt: "p", model: "nope/none" });

    expect(result.isError).toBe(true);
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("lets the caller's thinking and max_turns win over the file's", async () => {
    writeAgent("tuned", "thinking: low\nmax_turns: 20\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, { subagent_type: "tuned", description: "d", prompt: "p", thinking: "high", max_turns: 5 });

    expect(spawnAndWait.mock.calls[0][4]).toMatchObject({ thinkingLevel: "high", maxTurns: 5 });
  });

  it("carries the displaced file values and the pin to the child's invocation", async () => {
    writeAgent("tuned", "model: anthropic/blocked\nthinking: low\nmax_turns: 20\nrun_in_background: true\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, {
      subagent_type: "tuned",
      description: "d",
      prompt: "p",
      model: "anthropic/allowed",
      thinking: "high",
      max_turns: 5,
      run_in_background: false,
    });

    expect(spawnAndWait.mock.calls[0][4].invocation).toMatchObject({
      pinnedModel: "anthropic/blocked",
      pinnedThinking: "low",
      pinnedMaxTurns: 20,
      pinnedRunInBackground: true,
    });
  });

  it("passes a caller max_turns of 0 as an explicit unlimited", async () => {
    writeAgent("tuned", "max_turns: 20\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, { subagent_type: "tuned", description: "d", prompt: "p", max_turns: 0 });

    expect(spawnAndWait.mock.calls[0][4].maxTurns).toBe(0);
  });

  it("uses the file's thinking and max_turns when the caller is silent", async () => {
    writeAgent("tuned", "thinking: low\nmax_turns: 20\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, { subagent_type: "tuned", description: "d", prompt: "p" });

    expect(spawnAndWait.mock.calls[0][4]).toMatchObject({ thinkingLevel: "low", maxTurns: 20 });
  });

  it("lets the caller's run_in_background win over the file's, and defaults nested calls to foreground", async () => {
    writeAgent("detached", "run_in_background: true\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    await execute(agent, { subagent_type: "detached", description: "d", prompt: "p", run_in_background: false });
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();

    await execute(agent, { subagent_type: "scout", description: "d", prompt: "p" });
    expect(spawnAndWait).toHaveBeenCalledTimes(2);
  });

  it("queues a steer for an owned child whose session is not ready yet", async () => {
    const [, , steer] = tools();
    const record: Record<string, unknown> = {
      id: "child-1",
      status: "running",
      parentAgentId: "parent-1",
    };
    records.set("child-1", record);

    const result = await execute(steer, { agent_id: "child-1", message: "focus on tests" });

    expect(result.isError).toBe(false);
    expect(record.pendingSteers).toEqual(["focus on tests"]);
  });

  it("blocks delegation at the inherited depth cap", async () => {
    const [agent] = tools("all", 2, 2);
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth=2, max=2");
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("rejects unknown or disabled nested agent types instead of falling back", async () => {
    writeAgent("disabled", "enabled: false\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    for (const subagentType of ["missing", "disabled"]) {
      const result = await execute(agent, {
        subagent_type: subagentType,
        description: "invalid agent",
        prompt: "Do work",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or disabled");
    }
  });

  it("supports background launches and ownership-scopes result, resume, and steer", async () => {
    const [agent, getResult, steer] = tools(["scout"]);
    const launched = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      run_in_background: true,
    });
    expect(launched.content[0].text).toContain("child-1");
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "scout", "Find them",
      expect.objectContaining({ isBackground: true, depth: 2, parentAgentId: "parent-1" }),
    );

    const own = await execute(getResult, { agent_id: "child-1" });
    expect(own.isError).toBe(false);

    records.set("foreign", {
      id: "foreign",
      status: "running",
      result: "secret",
      parentAgentId: "other",
      session: { steer: vi.fn() },
    });
    expect((await execute(getResult, { agent_id: "foreign" })).isError).toBe(true);
    expect((await execute(steer, { agent_id: "foreign", message: "stop" })).isError).toBe(true);
    expect((await execute(agent, {
      resume: "foreign",
      subagent_type: "scout",
      description: "resume foreign",
      prompt: "Continue",
    })).isError).toBe(true);
    expect(manager.resume).not.toHaveBeenCalled();
  });

  it("stops a running owned child and marks who stopped it", async () => {
    const [, , , stop] = tools();
    const record: Record<string, unknown> = { id: "child-1", status: "running", parentAgentId: "parent-1" };
    records.set("child-1", record);

    const result = await execute(stop, { agent_id: "child-1" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("stopped");
    expect(record.status).toBe("stopped");
    expect(record.stoppedBy).toBe("agent");
    expect(manager.abort).toHaveBeenCalledWith("child-1");
  });

  it("reports an unknown or unowned stop target as not found and leaves it alone", async () => {
    const [, , , stop] = tools();
    const foreign = { id: "foreign", status: "running", parentAgentId: "other" };
    records.set(foreign.id, foreign);

    const unknown = await execute(stop, { agent_id: "does-not-exist" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("not found or not owned");

    const notOwned = await execute(stop, { agent_id: "foreign" });
    expect(notOwned.isError).toBe(true);
    expect(notOwned.content[0].text).toContain("not found or not owned");

    expect(foreign.status).toBe("running");
    expect(manager.abort).not.toHaveBeenCalled();
  });

  it("reports an already-settled child's terminal status as success, not an error", async () => {
    const [, , , stop] = tools();
    const record = { id: "child-1", status: "completed", result: "done", parentAgentId: "parent-1" };
    records.set(record.id, record);

    const result = await execute(stop, { agent_id: record.id });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("not running (status: completed)");
    expect(result.content[0].text).toContain("still available");
    expect(record.status).toBe("completed");
    expect(manager.abort).not.toHaveBeenCalled();
  });

  it("reports a background child that fails to start as a tool error", async () => {
    vi.mocked(manager.awaitStartup).mockRejectedValueOnce(
      new Error('Cannot run with isolation: "worktree"'),
    );
    const [agent] = tools(["scout"]);

    const result = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      run_in_background: true,
      isolation: "worktree",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('isolation: "worktree"');
  });

  it("waits for a queued owned child to start and settle", async () => {
    const [, getResult] = tools();
    const record = {
      id: "queued-child",
      status: "queued",
      parentAgentId: "parent-1",
      promise: undefined as Promise<unknown> | undefined,
      result: undefined as string | undefined,
    };
    records.set(record.id, record);
    setTimeout(() => {
      record.status = "running";
      record.promise = Promise.resolve().then(() => {
        record.status = "completed";
        record.result = "queued done";
      });
    }, 10);

    const result = await execute(getResult, { agent_id: record.id, wait: true });

    expect(result.content[0].text).toBe("queued done");
  });

  it("aborts a nested result wait without aborting the owned child", async () => {
    const [, getResult] = tools();
    let settleChild: (() => void) | undefined;
    const record = {
      id: "running-child",
      status: "running",
      parentAgentId: "parent-1",
      promise: new Promise<void>(resolve => { settleChild = resolve; }),
    };
    records.set(record.id, record);

    const controller = new AbortController();
    const outcome = getResult
      .execute("call-abort", { agent_id: record.id, wait: true }, controller.signal, undefined, ctx())
      .then(() => "resolved", (e: unknown) => (e instanceof Error ? e.name : String(e)));

    controller.abort();
    const settled = await Promise.race([
      outcome,
      new Promise(r => setTimeout(() => r("timed-out"), 100)),
    ]);

    expect(settled).toBe("AbortError");
    expect(record.status).toBe("running");
    settleChild?.();
  });

  it("rejects unknown types", async () => {
    const [agent] = tools(["scout"]);
    const result = await execute(agent, {
      subagent_type: "definitely-missing",
      description: "typo",
      prompt: "Do work",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown or disabled nested agent type");
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("hands the branch cap down to the child it spawns", async () => {
    const [agent] = tools("all", 1, 3);
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "child",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "scout", "Do work",
      expect.objectContaining({ depth: 2, maxSubagentDepth: 3 }),
      expect.any(Function),
    );
  });

  it("flags a truncated child run instead of passing partial output off as complete", async () => {
    spawnAndWait.mockImplementation(async () => ({
      id: "child-1",
      record: { id: "child-1", status: "steered", result: "half an answer", parentAgentId: "parent-1" },
    }));
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "truncated",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("everything the agent produced is above");
    expect(result.content[0].text).not.toContain("output is partial");
    expect(result.content[0].text.indexOf("half an answer")).toBeGreaterThan(0);
  });

  it("uses the fetchable wording when the parent polls a background child by id", async () => {
    records.set("child-1", {
      id: "child-1", status: "aborted", result: "partial work", parentAgentId: "parent-1",
    });
    const [, getResult] = tools();
    const result = await execute(getResult, { agent_id: "child-1" });

    expect(result.content[0].text).toContain("output may be incomplete");
    expect(result.content[0].text).not.toContain("everything the agent produced is above");
  });

  it("keeps a failed child's partial output alongside the error", async () => {
    spawnAndWait.mockImplementation(async () => ({
      id: "child-1",
      record: {
        id: "child-1", status: "error", error: "provider exploded",
        result: "got this far", parentAgentId: "parent-1",
      },
    }));
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "failing",
      prompt: "Do work",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("provider exploded");
    expect(result.content[0].text).toContain("got this far");
  });

  it("attributes a nested child's token spend to the owning parent", async () => {
    const parent = { id: "parent-1", status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    records.set("parent-1", parent);
    spawn.mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 5 });
      return "child-1";
    });

    const [agent] = tools();
    await execute(agent, {
      subagent_type: "scout",
      description: "spender",
      prompt: "Do work",
      run_in_background: true,
    });

    expect(parent.lifetimeUsage).toEqual({ input: 100, output: 20, cacheWrite: 5 });
  });

  it("attributes spend up the whole ancestor chain, not just one level", async () => {
    const top = { id: "top", status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    const middle = {
      id: "parent-1", status: "running", parentAgentId: "top",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    };
    records.set("top", top);
    records.set("parent-1", middle);
    spawn.mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 1 });
      return "child-1";
    });

    const [agent] = tools();
    await execute(agent, {
      subagent_type: "scout",
      description: "deep spender",
      prompt: "Do work",
      run_in_background: true,
    });

    expect(middle.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
    expect(top.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
  });

  it("files a nested transcript under the root session, honoring output_transcript", async () => {
    records.set("parent-1", { id: "parent-1", status: "running", rootSessionId: "root-session" });
    spawnAndWait.mockImplementation(async (_pi, _ctx, type, _prompt, options, onSpawned) => {
      const record = { id: "child-1", type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
      records.set("child-1", record);
      onSpawned?.("child-1");
      return { id: "child-1", record };
    });

    const transcriptRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
    try {
      const [agent] = tools();
      await execute(agent, { subagent_type: "scout", description: "traced", prompt: "Do work" });
      expect(records.get("child-1").outputFile).toContain(join("root-session", "tasks", "child-1.output"));

      writeAgent("quiet", "output_transcript: false\n");
      registerAgents(loadCustomAgents(cwd));
      records.delete("child-1");
      await execute(agent, { subagent_type: "quiet", description: "untraced", prompt: "Do work" });
      expect(records.get("child-1").outputFile).toBeUndefined();
    } finally {
      rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });

  it("forwards the execution context to the manager unmodified", async () => {
    const [agent] = tools();
    const executionCtx = ctx();
    await agent.execute("call-1", {
      subagent_type: "scout",
      description: "ctx check",
      prompt: "Do work",
    } as any, undefined, undefined, executionCtx);

    expect(spawnAndWait.mock.calls[0][1]).toBe(executionCtx);
  });
});

describe("setMaxSubagentDepth clamping", () => {
  let previous: number;
  beforeEach(() => { previous = getMaxSubagentDepth(); });
  afterEach(() => { setMaxSubagentDepth(previous); });

  it("floors a negative depth at 0 rather than storing it", () => {
    setMaxSubagentDepth(-1);
    expect(getMaxSubagentDepth()).toBe(0);
  });

  it("truncates a fractional depth toward zero", () => {
    setMaxSubagentDepth(2.9);
    expect(getMaxSubagentDepth()).toBe(2);
  });

  it("stores a valid depth unchanged", () => {
    setMaxSubagentDepth(3);
    expect(getMaxSubagentDepth()).toBe(3);
  });
});

describe("resolveNestedModel", () => {
  const registry = ctx().modelRegistry;
  const fallback = { provider: "fallback", id: "model" } as any;

  it("returns ctx model when no model input", () => {
    expect(resolveNestedModel({ modelInput: undefined, modelFromParams: false }, fallback, registry)).toEqual({ model: fallback });
  });

  it("resolves a known model", () => {
    const r = resolveNestedModel({ modelInput: "anthropic/allowed", modelFromParams: true }, fallback, registry);
    expect(r).toEqual({ model: { provider: "anthropic", id: "allowed" } });
  });

  it("errors when an unresolved model came from params", () => {
    const r = resolveNestedModel({ modelInput: "nope/none", modelFromParams: true }, fallback, registry);
    expect(r).toEqual({ error: expect.any(String) });
  });

  it("falls back to ctx model when an unresolved model came from config", () => {
    const r = resolveNestedModel({ modelInput: "nope/none", modelFromParams: false }, fallback, registry);
    expect(r).toEqual({ model: fallback });
  });
});

describe("resolveNestedType", () => {
  const registry = buildAgentRegistry(new Map());

  it("rejects unknown types with the allowed list", () => {
    const r = resolveNestedType(registry, "nope", undefined);
    expect(r).toEqual({ error: expect.stringContaining('Unknown or disabled nested agent type: "nope"') });
  });

  it("rejects a type outside the allowlist", () => {
    const r = resolveNestedType(registry, "general-purpose", new Set(["Explore"]));
    expect(r).toEqual({ error: expect.stringContaining("is not allowed for this parent. Allowed: Explore.") });
  });

  it("resolves an allowed type", () => {
    expect(resolveNestedType(registry, "general-purpose", undefined)).toEqual({ type: "general-purpose" });
    expect(resolveNestedType(registry, "general-purpose", new Set(["general-purpose"]))).toEqual({ type: "general-purpose" });
  });
});

describe("addUsageToAncestors", () => {
  it("adds usage to every ancestor, stopping at a missing record", () => {
    const mk = (parentAgentId?: string) => ({ parentAgentId, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } }) as any;
    const recs = new Map<string, any>([["a", mk("b")], ["b", mk(undefined)]]);
    addUsageToAncestors({ getRecord: (id: string) => recs.get(id) } as any, "a", { input: 1, output: 2, cacheWrite: 3 });
    expect(recs.get("a").lifetimeUsage.input).toBe(1);
    expect(recs.get("b").lifetimeUsage.output).toBe(2);
    expect(() => addUsageToAncestors({ getRecord: () => undefined } as any, "x", { input: 1, output: 1, cacheWrite: 1 })).not.toThrow();
  });
});
