import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { BUILTIN_TOOL_NAMES, registerAgents } from "../src/agents/agent-types.js";
import {
  type CapabilityDeclaration,
  type CapabilityField,
  checkCapabilityPolicy,
  type EffectiveCapabilities,
  isMintedVerdict,
} from "../src/config/capability-policy.js";
import type { LoadedPolicy, PolicyScope } from "../src/config/capability-policy-config.js";
import subagentsExtension from "../src/index.js";
import { AgentManager } from "../src/manager/agent-manager.js";
import { runAgent } from "../src/session/agent-runner.js";
import { createNestedSubagentTools } from "../src/tool/nested-tools.js";
import { registerRpcHandlers } from "../src/triggers/cross-extension-rpc.js";
import { SubagentScheduler } from "../src/triggers/schedule.js";
import { ScheduleStore } from "../src/triggers/schedule-store.js";
import { createSpawnFunnel } from "../src/triggers/spawn-funnel.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";
import { grant } from "./helpers/capability.js";

const OPEN: CapabilityDeclaration = { extensions: true, skills: true };

function policyOf(global: PolicyScope = {}, project: PolicyScope = {}, ephemeralNesting = true): LoadedPolicy {
  return { global, project, ephemeralNesting, problems: [] };
}

function check(
  config: Partial<CapabilityDeclaration>,
  policy: LoadedPolicy,
  options: { caller?: CapabilityField[]; ephemeral?: boolean; isolated?: boolean } = {},
) {
  return checkCapabilityPolicy({
    config: { ...OPEN, ...config },
    callerSupplied: new Set(options.caller ?? []),
    ephemeral: options.ephemeral ?? false,
    cwd: process.cwd(),
    isolated: options.isolated,
    policy,
  });
}

function granted(verdict: ReturnType<typeof check>): { capabilities: EffectiveCapabilities; filtered: string[] } {
  if (verdict.kind !== "ok") throw new Error(`expected ok, got ${verdict.message}`);
  return verdict;
}

describe("checkCapabilityPolicy", () => {
  it("allows everything under an empty policy and mints a verdict", () => {
    const verdict = check({}, policyOf());
    const { capabilities, filtered } = granted(verdict);
    expect(capabilities.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(capabilities.extensions).toBe(true);
    expect(capabilities.skills).toBe(true);
    expect(capabilities.noExtensionTools).toBe(false);
    expect(filtered).toEqual([]);
    expect(isMintedVerdict(verdict)).toBe(true);
    expect(isMintedVerdict({ ...verdict })).toBe(false);
  });

  it("denies every spawn when the policy is malformed", () => {
    const verdict = check({}, { ...policyOf(), problems: ["/p/subagents.json: policy.tools must be an object"] });
    expect(verdict).toEqual({
      kind: "error",
      message: expect.stringMatching(/^Capability policy: .*\/p\/subagents\.json/),
    });
  });

  describe("tools", () => {
    it("filters a file's built-in tools against a deny list", () => {
      const { capabilities, filtered } = granted(
        check({ builtinToolNames: ["read", "bash"] }, policyOf({ tools: { deny: ["bash"] } })),
      );
      expect(capabilities.builtinToolNames).toEqual(["read"]);
      expect(filtered).toEqual(["tool bash"]);
    });

    it("filters default built-ins down to an allow list", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read", "grep"] } })));
      expect(capabilities.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES.filter(name => ["read", "grep"].includes(name)));
    });

    it("refuses a caller-supplied denied tool", () => {
      const verdict = check({ builtinToolNames: ["bash"] }, policyOf({ tools: { deny: ["bash"] } }), { caller: ["tools"] });
      expect(verdict).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: .*bash.*global policy\.tools\.deny/) });
    });

    it("refuses a caller-supplied tool missing from an allow list", () => {
      const verdict = check({ builtinToolNames: ["write"] }, policyOf({ tools: { allow: ["read"] } }), { caller: ["tools"] });
      expect(verdict.kind).toBe("error");
    });

    it("evaluates global and project separately, so a project only narrows", () => {
      const { capabilities } = granted(
        check({}, policyOf({ tools: { allow: ["read", "bash"] } }, { tools: { allow: ["read", "write"] } })),
      );
      expect(capabilities.builtinToolNames).toEqual(["read"]);
    });

    it("lets deny beat allow", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["*", "read"], deny: ["read"] } })));
      expect(capabilities.builtinToolNames).not.toContain("read");
    });

    it("refuses when filtering empties an explicit tool list", () => {
      const verdict = check({ builtinToolNames: ["bash"] }, policyOf({ tools: { deny: ["bash"] } }));
      expect(verdict).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: .*no tools/) });
    });

    it("does not refuse an explicit empty tool list", () => {
      expect(check({ builtinToolNames: [] }, policyOf({ tools: { allow: ["read"] } })).kind).toBe("ok");
    });

    it("permits no extension tools when the allow list has no ext entry and no wildcard", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read"] } })));
      expect(capabilities.noExtensionTools).toBe(true);
    });

    it("permits extension tools under a wildcard allow", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["*"] } })));
      expect(capabilities.noExtensionTools).toBe(false);
      expect(capabilities.extSelectors).toEqual([]);
    });

    it("expands an unrestricted agent to the allowed ext selectors", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { allow: ["read", "ext:web", "ext:db/query"] } })));
      expect(capabilities.extSelectors).toEqual(["ext:web", "ext:db/query"]);
      expect(capabilities.noExtensionTools).toBe(false);
    });

    it("narrows a whole-extension selector to the allowed tool", () => {
      const { capabilities } = granted(
        check({ extSelectors: ["ext:web"] }, policyOf({ tools: { allow: ["read", "ext:web/fetch"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual(["ext:web/fetch"]);
    });

    it("drops a selector outside the allow list without refusing, and permits no extension tools", () => {
      const { capabilities, filtered } = granted(
        check({ extSelectors: ["ext:web"], builtinToolNames: ["read"] }, policyOf({ tools: { allow: ["read", "ext:db"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual([]);
      expect(capabilities.noExtensionTools).toBe(true);
      expect(filtered).toContain("ext:web");
    });

    it("turns ext:<extension> deny into a denied extension and ext:<extension>/<tool> into a tool deny", () => {
      const { capabilities } = granted(check({}, policyOf({ tools: { deny: ["ext:web", "ext:db/drop", "mystery"] } })));
      expect(capabilities.deniedExtensionNames).toEqual(["web"]);
      expect(capabilities.disallowedTools).toEqual(expect.arrayContaining(["drop", "mystery"]));
    });

    it("drops a denied whole-extension selector without refusing a caller", () => {
      const { capabilities } = granted(
        check({ extSelectors: ["ext:web"], builtinToolNames: ["read"] }, policyOf({ tools: { deny: ["ext:web"] } }), { caller: ["tools"] }),
      );
      expect(capabilities.extSelectors).toEqual([]);
    });

    it("keeps a file's existing disallowed tools", () => {
      const { capabilities } = granted(check({ disallowedTools: ["edit"] }, policyOf()));
      expect(capabilities.disallowedTools).toEqual(["edit"]);
    });
  });

  describe("extensions", () => {
    it("expands extensions: true to the allow list and excludes denied names", () => {
      const allowed = granted(check({}, policyOf({ extensions: { allow: ["Web", "db"] } })));
      expect(allowed.capabilities.extensions).toEqual(["web", "db"]);
      const denied = granted(check({}, policyOf({ extensions: { deny: ["risky"] } })));
      expect(denied.capabilities.extensions).toBe(true);
      expect(denied.capabilities.excludeExtensions).toEqual(["risky"]);
    });

    it("expands a wildcard entry like true", () => {
      const { capabilities } = granted(check({ extensions: ["*"] }, policyOf({ extensions: { allow: ["web"] } }), { caller: ["extensions"] }));
      expect(capabilities.extensions).toEqual(["web"]);
    });

    it("intersects the global and project allow lists", () => {
      const { capabilities } = granted(check({}, policyOf({ extensions: { allow: ["a", "b"] } }, { extensions: { allow: ["b", "c"] } })));
      expect(capabilities.extensions).toEqual(["b"]);
    });

    it("filters a file's extension and refuses a caller's", () => {
      const policy = policyOf({ extensions: { deny: ["risky"] } });
      const filtered = granted(check({ extensions: ["web", "risky"] }, policy));
      expect(filtered.capabilities.extensions).toEqual(["web"]);
      expect(filtered.filtered).toEqual(["extension risky"]);
      const refused = check({ extensions: ["web", "risky"] }, policy, { caller: ["extensions"] });
      expect(refused).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: extension "risky".*policy\.extensions\.deny/) });
    });

    it("refuses a caller-supplied path whenever an allow list is set", () => {
      const verdict = check({ extensions: ["./ext/web.ts"] }, policyOf({ extensions: { allow: ["web"] } }), { caller: ["extensions"] });
      expect(verdict.kind).toBe("error");
      expect(check({ extensions: ["./ext/web.ts"] }, policyOf({ extensions: { deny: ["x"] } }), { caller: ["extensions"] }).kind).toBe("ok");
    });

    it("matches a file's path entry by canonical name", () => {
      const { capabilities } = granted(check({ extensions: ["./ext/web.ts", "./ext/db.ts"] }, policyOf({ extensions: { allow: ["web"] } })));
      expect(capabilities.extensions).toEqual(["./ext/web.ts"]);
    });

    it("refuses a caller ext selector whose extension is denied by policy.extensions", () => {
      const verdict = check({ extSelectors: ["ext:risky"], builtinToolNames: ["read"] }, policyOf({ extensions: { deny: ["risky"] } }), { caller: ["tools"] });
      expect(verdict.kind).toBe("error");
    });

    it("stays false under extensions: false and under isolated", () => {
      expect(granted(check({ extensions: false }, policyOf())).capabilities.extensions).toBe(false);
      const isolated = granted(check({ extSelectors: ["ext:web"] }, policyOf(), { isolated: true }));
      expect(isolated.capabilities.extensions).toBe(false);
      expect(isolated.capabilities.skills).toBe(false);
      expect(isolated.capabilities.extSelectors).toEqual([]);
    });
  });

  describe("skills", () => {
    it("narrows skills: true through a skill scope", () => {
      const { capabilities } = granted(check({}, policyOf({ skills: { allow: ["Review", "lint"], deny: ["lint"] } })));
      expect(capabilities.skills).toBe(true);
      expect(capabilities.skillScope).toEqual({ allow: ["review", "lint"], deny: ["lint"] });
    });

    it("filters named skills for a file and refuses a caller", () => {
      const policy = policyOf({ skills: { deny: ["Secret"] } });
      const filtered = granted(check({ skills: ["ok", "secret"] }, policy));
      expect(filtered.capabilities.skills).toEqual(["ok"]);
      expect(filtered.filtered).toEqual(["skill secret"]);
      const refused = check({ skills: ["ok", "secret"] }, policy, { caller: ["skills"] });
      expect(refused).toEqual({ kind: "error", message: expect.stringMatching(/^Capability policy: skill "secret"/) });
    });

    it("leaves skills: false alone", () => {
      expect(granted(check({ skills: false }, policyOf({ skills: { allow: ["x"] } }))).capabilities.skills).toBe(false);
    });
  });

  describe("ephemeralNesting", () => {
    it("forces allowed_subagents to [] for an ephemeral agent when off", () => {
      const off = policyOf({}, {}, false);
      expect(granted(check({ allowedSubagents: "all" }, off, { ephemeral: true })).capabilities.allowedSubagents).toEqual([]);
      expect(granted(check({}, off, { ephemeral: true })).capabilities.allowedSubagents).toEqual([]);
    });

    it("refuses a caller allowed_subagents other than []", () => {
      const off = policyOf({}, {}, false);
      expect(check({ allowedSubagents: ["a"] }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("error");
      expect(check({ allowedSubagents: "all" }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("error");
      expect(check({ allowedSubagents: [] }, off, { ephemeral: true, caller: ["allowedSubagents"] }).kind).toBe("ok");
    });

    it("leaves named agents alone", () => {
      const off = policyOf({}, {}, false);
      expect(granted(check({ allowedSubagents: "all" }, off)).capabilities.allowedSubagents).toBe("all");
    });
  });
});

describe("capability policy at every spawn path", () => {
  let hermetic: Hermetic;
  let booted: Map<string, any> | undefined;

  const writePolicy = (policy: unknown) =>
    writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false, policy }));

  beforeEach(() => {
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, outputTranscript: false },
      agentFiles: { scout: "---\ndescription: scouts\ntools: read, bash\n---\nbody" },
    });
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
  });

  afterEach(async () => {
    await booted?.get("session_shutdown")?.();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    booted = undefined;
    registerAgents(new Map());
    hermetic.restore();
  });

  const inlineConfig = (tools: string[]) => ({ systemPrompt: "p", builtinToolNames: tools, extensions: false, skills: false });

  function rpcHarness({ manager, spawnTopLevel }: ReturnType<typeof funnel>) {
    const handlers = new Map<string, (raw: any) => unknown>();
    const replies: Array<{ channel: string; data: any }> = [];
    registerRpcHandlers({
      events: {
        on: (channel: string, fn: (raw: any) => unknown) => {
          handlers.set(channel, fn);
          return () => {};
        },
        emit: (channel: string, data: unknown) => replies.push({ channel, data }),
      },
      pi: {},
      getCtx: () => ctx(),
      manager: {
        spawn: spawnTopLevel,
        awaitStartup: id => manager.awaitStartup(id),
        getRecord: id => manager.getRecord(id),
        abort: id => manager.abort(id),
        consumeResult: () => false,
      },
    });
    return { handlers, replies };
  }

  function funnel() {
    const manager = new AgentManager();
    return { manager, ...createSpawnFunnel({ manager, reloadCustomAgents: () => {} }) };
  }

  it("refuses a caller-supplied denied tool through the registry spawn", () => {
    writePolicy({ tools: { deny: ["bash"] } });
    const { spawnTopLevel } = funnel();
    const spawnViaRegistry = () =>
      spawnTopLevel({}, ctx(), "adhoc", "go", { description: "d", agentConfig: inlineConfig(["read", "bash"]) });
    expect(spawnViaRegistry).toThrow(/^Capability policy: tool "bash"/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied denied tool through subagents:rpc:spawn", async () => {
    writePolicy({ tools: { deny: ["bash"] } });
    const { handlers, replies } = rpcHarness(funnel());
    const request = (requestId: string, tools: string[]) =>
      handlers.get("subagents:rpc:spawn")?.({
        requestId,
        type: "adhoc",
        prompt: "go",
        options: { description: "d", agentConfig: inlineConfig(tools) },
      });

    await request("denied", ["bash"]);
    const refused = replies.find(r => r.channel === "subagents:rpc:spawn:reply:denied");
    expect(refused?.data.success).toBe(false);
    expect(refused?.data.error).toMatch(/^Capability policy: tool "bash"/);

    await request("allowed", ["read"]);
    const accepted = replies.find(r => r.channel === "subagents:rpc:spawn:reply:allowed");
    expect(accepted?.data).toEqual({ success: true, data: { id: expect.any(String) } });
  });

  it("reports what an RPC spawn had filtered out", async () => {
    writePolicy({ tools: { deny: ["bash"] } });
    const { handlers, replies } = rpcHarness(funnel());
    registerAgents(new Map([["scout", { name: "scout", description: "s", builtinToolNames: ["read", "bash"], extensions: false, skills: false, systemPrompt: "p", promptMode: "replace" }]]));
    await handlers.get("subagents:rpc:spawn")?.({ requestId: "f", type: "scout", prompt: "go", options: { description: "d" } });
    const reply = replies.find(r => r.channel === "subagents:rpc:spawn:reply:f");
    expect(reply?.data).toEqual({ success: true, data: { id: expect.any(String), filtered: ["tool bash"] } });
  });

  it("filters an agent file's value when a scheduled job fires", () => {
    writePolicy({ tools: { deny: ["bash"] } });
    registerAgents(new Map([["scout", { name: "scout", description: "s", builtinToolNames: ["read", "bash"], extensions: false, skills: false, systemPrompt: "p", promptMode: "replace" }]]));
    vi.useFakeTimers();
    const scheduler = new SubagentScheduler();
    const spawn = vi.fn(() => "agent-1");
    const manager: any = { spawn, awaitStartup: vi.fn(async () => {}), getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })) };
    const notify = vi.fn();
    const firing = { ...ctx(), ui: { notify } };
    try {
      scheduler.start({ events: { emit: vi.fn() } } as any, firing, manager, new ScheduleStore(join(hermetic.dir, "jobs.json")));
      scheduler.addJob({ name: "tick", description: "tick", schedule: "+1s", subagent_type: "scout", prompt: "go" });
      vi.advanceTimersByTime(2_000);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
    const options = (spawn.mock.calls as any[][])[0][4];
    expect(options.capability.capabilities.builtinToolNames).toEqual(["read"]);
    expect(options.capability.filtered).toEqual(["tool bash"]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("tool bash"), "warning");
  });

  it("filters an agent file's value on a direct mention", async () => {
    writePolicy({ tools: { deny: ["bash"] } });
    writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false, agentMentions: "direct", policy: { tools: { deny: ["bash"] } } }));
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    booted = lifecycle;
    const uiCtx = ctx();
    await lifecycle.get("input")({ type: "input", text: "@scout look around", source: "interactive" }, uiCtx);
    await flush();
    const options = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(options.capability.capabilities.builtinToolNames).toEqual(["read"]);
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool bash"), "warning");
  });

  describe("reopening a tombstone", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
    afterEach(() => vi.useRealTimers());

    it("checks the policy again instead of reusing the first verdict", async () => {
      writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false, agentMentions: "direct" }));
      const { pi, lifecycle } = makePi();
      subagentsExtension(pi);
      booted = lifecycle;
      vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}), getActiveToolNames: vi.fn(() => []) } as any, aborted: false, steered: false } as any);
      await lifecycle.get("input")({ type: "input", text: "@scout first", source: "interactive" }, ctx());
      await flush();
      const first = vi.mocked(runAgent).mock.calls[0][3] as any;
      expect(first.capability.capabilities.builtinToolNames).toEqual(["read", "bash"]);

      const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      const record = manager.getRecord(first.agentId);
      record.sessionFile = join(hermetic.dir, "scout-session.jsonl");
      writeFileSync(record.sessionFile, "");
      record.completedAt = Date.now() - 11 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getRecord(first.agentId)).toBeUndefined();

      writeFileSync(join(hermetic.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false, agentMentions: "direct", policy: { tools: { deny: ["bash"] } } }));
      vi.mocked(runAgent).mockClear();
      const uiCtx = ctx();
      await lifecycle.get("input")({ type: "input", text: "@scout again", source: "interactive" }, uiCtx);
      await flush();
      const reopened = vi.mocked(runAgent).mock.calls[0][3] as any;
      expect(reopened.resumeSessionFile).toBe(record.sessionFile);
      expect(reopened.capability.capabilities.builtinToolNames).toEqual(["read"]);
      expect(uiCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool bash"), "warning");
    });
  });

  it("puts a note in the agent tool result and stores the filtered values on the record", async () => {
    writePolicy({ tools: { deny: ["bash"] } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    booted = lifecycle;
    const agentTool = tools.get("agent");
    const result = await agentTool.execute(
      "tc-1",
      { prompt: "go", description: "look", subagent_type: "scout", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(result)).toContain("the capability policy removed tool bash");
    const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1] ?? "";
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    await flush();
    expect(registry.getRecord(id).filtered).toEqual(["tool bash"]);
  });

  it("refuses a malformed policy through the agent tool", async () => {
    mkdirSync(join(hermetic.dir, ".pi"), { recursive: true });
    writePolicy({ tools: { deny: ["*"] } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    booted = lifecycle;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agentTool = tools.get("agent");
    const result = await agentTool.execute(
      "tc-1",
      { prompt: "go", description: "look", subagent_type: "scout", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(result)).toMatch(/^Capability policy: the policy is malformed/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied denied tool through an ephemeral agent call", async () => {
    writePolicy({ tools: { deny: ["bash"] } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    booted = lifecycle;
    const agentTool = tools.get("agent");
    const call = (params: Record<string, unknown>) =>
      agentTool.execute("tc", { prompt: "go", description: "look", run_in_background: true, ...params }, undefined, undefined, ctx());

    const refused = await call({ tools: ["read", "bash"] });
    expect(textOf(refused)).toMatch(/^Capability policy: tool "bash"/);
    expect(runAgent).not.toHaveBeenCalled();

    const narrowed = await call({ tools: ["*"] });
    expect(textOf(narrowed)).toContain("started in background");
    const options = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(options.capability.capabilities.builtinToolNames).not.toContain("bash");
  });

  it("refuses ephemeral values outside the policy through the nested tool", async () => {
    writePolicy({ tools: { deny: ["bash"] }, extensions: { deny: ["risky"] }, skills: { deny: ["secret"] }, ephemeralNesting: false });
    const spawnAndWait = vi.fn();
    const manager: any = {
      spawn: vi.fn(),
      spawnAndWait,
      awaitStartup: vi.fn(),
      getRecord: (id: string) => (id === "parent-1" ? { id, capabilities: grant().capabilities } : undefined),
      resume: vi.fn(),
      abort: vi.fn(),
    };
    const [nestedAgent] = createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: hermetic.dir,
    }) as any[];
    const nestedCtx = { ...ctx(), cwd: hermetic.dir };
    const call = (params: Record<string, unknown>) =>
      nestedAgent.execute("n", { description: "d", prompt: "go", ...params }, undefined, undefined, nestedCtx);

    expect(textOf(await call({ tools: ["bash"] }))).toMatch(/^Capability policy: tool "bash"/);
    expect(textOf(await call({ extensions: ["risky"] }))).toMatch(/^Capability policy: extension "risky"/);
    expect(textOf(await call({ skills: ["secret"] }))).toMatch(/^Capability policy: skill "secret"/);
    expect(textOf(await call({ allowed_subagents: "all" }))).toMatch(/^Capability policy: allowed_subagents/);
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("makes spawnAgent throw without a verdict", () => {
    const manager = new AgentManager();
    expect(() => manager.spawn({} as any, ctx(), "scout", "go", { description: "d" })).toThrow(/^Capability policy: a spawn needs a verdict/);
    const forged = { kind: "ok", capabilities: {}, filtered: [] } as any;
    expect(() => manager.spawn({} as any, ctx(), "scout", "go", { description: "d", capability: forged })).toThrow(/needs a verdict/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("strips a verdict a registry caller supplies", () => {
    const { spawnTopLevel, manager } = funnel();
    const spawn = vi.spyOn(manager, "spawn");
    registerAgents(new Map([["scout", { name: "scout", description: "s", builtinToolNames: ["read"], extensions: false, skills: false, systemPrompt: "p", promptMode: "replace" }]]));
    const forged = { kind: "ok", capabilities: {}, filtered: [] };
    spawnTopLevel({}, ctx(), "scout", "go", { description: "d", capability: forged });
    const passed = (spawn.mock.calls[0][4] as any).capability;
    expect(passed).not.toBe(forged);
    expect(passed.capabilities.builtinToolNames).toEqual(["read"]);
  });
});
