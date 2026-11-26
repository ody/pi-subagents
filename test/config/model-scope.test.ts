import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../../src/agents/agent-types.js";
import type { ModelRegistryRef } from "../../src/config/enabled-models.js";
import {
  acceptedModelLines,
  acceptedModels,
  checkModelScope,
  isScopeModelsEnabled,
  modelScope,
  resolvePinnedModel,
  resolveScopedModel,
  scopeModel,
  setScopeModelsEnabled,
} from "../../src/config/model-scope.js";
import { registerRpcHandlers } from "../../src/triggers/cross-extension-rpc.js";
import { createSpawnFunnel } from "../../src/triggers/spawn-funnel.js";
import { testAgent } from "../harness/test-agents.js";

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS): ModelRegistryRef {
  return { getAll() { return models; }, getAvailable: undefined };
}

const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const OPUS = { provider: "anthropic", id: "claude-opus-4-6" };

describe("checkModelScope", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function setEnabledModels(models: string[]) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: models }));
  }

  function check(overrides: Partial<Parameters<typeof checkModelScope>[0]> = {}) {
    return checkModelScope({
      model: OPUS,
      cwd: projectDir,
      modelRegistry: makeRegistry(),
      callerSupplied: true,
      agentLabel: "scout",
      ...overrides,
    });
  }

  it("is a no-op while the feature is off, even for an out-of-scope model", () => {
    setScopeModelsEnabled(false);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when no model was resolved", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(check({ model: undefined }).kind).toBe("ok");
  });

  it("is a no-op when the user has no enabledModels configured", () => {
    setScopeModelsEnabled(true);
    expect(check().kind).toBe("ok");
  });

  it("is a no-op when enabledModels resolves to nothing usable", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/*", "haiku"]);
    expect(check().kind).toBe("ok");
  });

  it("passes an in-scope model", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-opus-4-6"]);
    expect(check().kind).toBe("ok");
  });

  describe("out of scope", () => {
    beforeEach(() => {
      setScopeModelsEnabled(true);
      setEnabledModels(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"]);
    });

    it("refuses a caller-supplied choice and lists what is allowed", () => {
      const verdict = check({ callerSupplied: true, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("error");
      const message = (verdict as { message: string }).message;
      expect(message).toContain('"anthropic/claude-opus-4-6"');
      expect(message).toContain("  anthropic/claude-haiku-4-5");
      expect(message).toContain("  anthropic/claude-sonnet-4-6");
    });

    it("replaces a frontmatter-pinned choice, so the spawn proceeds on the session model", () => {
      const verdict = check({ callerSupplied: false, modelInput: "anthropic/claude-opus-4-6" });
      expect(verdict.kind).toBe("replace");
      expect((verdict as { replaced: string }).replaced).toBe("anthropic/claude-opus-4-6");
      expect((verdict as { message: string }).message)
        .toBe('Agent "scout" pins out-of-scope model "anthropic/claude-opus-4-6"; using the session model instead');
    });

    it("scopeModel swaps in the session model for a replaced pin", () => {
      const session = HAIKU;
      const scoped = scopeModel({
        pinned: OPUS,
        sessionModel: session,
        cwd: projectDir,
        modelRegistry: makeRegistry(),
        callerSupplied: false,
        agentLabel: "scout",
        modelInput: "anthropic/claude-opus-4-6",
      });
      expect(scoped).toMatchObject({ ok: true, model: session, replaced: "anthropic/claude-opus-4-6" });
    });

    it("scopeModel never examines the session model when nothing is pinned", () => {
      const scoped = scopeModel({
        pinned: undefined,
        sessionModel: OPUS,
        cwd: projectDir,
        modelRegistry: makeRegistry(),
        callerSupplied: false,
        agentLabel: "scout",
      });
      expect(scoped).toEqual({ ok: true, model: OPUS });
    });

    it("names the resolved model in the replacement when there was no raw input", () => {
      const verdict = check({ callerSupplied: false, modelInput: undefined });
      expect(verdict.kind).toBe("replace");
      expect((verdict as { message: string }).message).toContain("anthropic/claude-opus-4-6");
      expect((verdict as { message: string }).message).not.toContain("undefined");
    });

    it("stops enforcing as soon as the setting is turned back off", () => {
      expect(check().kind).toBe("error");
      setScopeModelsEnabled(false);
      expect(check().kind).toBe("ok");
    });

    it("treats scope as case-insensitive on both sides", () => {
      setEnabledModels(["Anthropic/Claude-Opus-4-6"]);
      expect(check({ model: OPUS }).kind).toBe("ok");
      expect(check({ model: HAIKU }).kind).toBe("error");
    });
  });
});

describe("spawn funnel scope", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let spawn: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let funnel: ReturnType<typeof createSpawnFunnel>;
  const SESSION = { provider: "anthropic", id: "claude-haiku-4-5" };

  function funnelCtx() {
    return {
      cwd: projectDir,
      model: SESSION,
      ui: { notify },
      modelRegistry: {
        getAll: () => MODELS,
        getAvailable: () => MODELS,
        find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
      },
    };
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-scope-funnel-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-scope-funnel-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }));
    setScopeModelsEnabled(true);
    registerAgents(new Map([
      ["pinned", testAgent("pinned", { model: "anthropic/claude-opus-4-6" })],
      ["inscope", testAgent("inscope", { model: "anthropic/claude-haiku-4-5" })],
      ["plain", testAgent("plain")],
    ]));
    spawn = vi.fn(() => "id-1");
    notify = vi.fn();
    funnel = createSpawnFunnel({ manager: { spawn, getRecord: vi.fn(), resolveMention: vi.fn() } as never, reloadCustomAgents: () => {} });
  });

  afterEach(() => {
    setScopeModelsEnabled(false);
    registerAgents(new Map());
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("replaces an out-of-scope file pin on a direct start and notifies", () => {
    funnel.spawnTopLevel({}, funnelCtx(), "pinned", "go", { description: "d" });
    expect(spawn.mock.calls[0][4]).toMatchObject({ model: SESSION, modelReplaced: "anthropic/claude-opus-4-6" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("anthropic/claude-opus-4-6"), "warning");
  });

  it("replaces an out-of-scope pin on a tombstone reopen through spawnResolved", () => {
    funnel.spawnResolved({}, funnelCtx(), "pinned", "go", { description: "d", resumeSessionFile: "/x", reclaim: { handle: "h" } });
    expect(spawn.mock.calls[0][4]).toMatchObject({ model: SESSION, modelReplaced: "anthropic/claude-opus-4-6" });
  });

  it("replaces an out-of-scope inline pin", () => {
    funnel.spawnTopLevel({}, funnelCtx(), "adhoc", "go", {
      description: "d",
      agentConfig: testAgent("adhoc", { model: "anthropic/claude-opus-4-6" }),
    });
    expect(spawn.mock.calls[0][4]).toMatchObject({ model: SESSION, modelReplaced: "anthropic/claude-opus-4-6" });
  });

  it("treats a blank caller model as absent over a file pin", () => {
    funnel.spawnTopLevel({}, funnelCtx(), "inscope", "go", { description: "d", model: "   " });
    expect(spawn.mock.calls[0][4]).toMatchObject({ model: { provider: "anthropic", id: "claude-haiku-4-5" } });
    expect(spawn.mock.calls[0][4].modelReplaced).toBeUndefined();
  });

  it("passes a resolved pin with its snapshot to a tombstone reopen", () => {
    setScopeModelsEnabled(false);
    const dated = { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" };
    const registry = {
      getAll: () => [dated],
      getAvailable: () => [dated],
      find: (provider: string, id: string) => (provider === dated.provider && id === dated.id ? dated : undefined),
    };
    registerAgents(new Map([["dated", testAgent("dated", { model: "haiku" })]]));

    funnel.spawnResolved({}, { ...funnelCtx(), modelRegistry: registry }, "dated", "go", {
      description: "d",
      resumeSessionFile: "/x",
      reclaim: { handle: "h" },
    });

    expect(spawn.mock.calls[0][4]).toMatchObject({ model: dated });
  });

  it("lets an unresolved pin inherit the session model on a tombstone reopen", () => {
    registerAgents(new Map([["ghost", testAgent("ghost", { model: "nope/none" })]]));

    funnel.spawnResolved({}, funnelCtx(), "ghost", "go", {
      description: "d",
      resumeSessionFile: "/x",
      reclaim: { handle: "h" },
    });

    expect(spawn.mock.calls[0][4].model).toBeUndefined();
    expect(spawn.mock.calls[0][4].modelReplaced).toBeUndefined();
  });

  it("leaves an in-scope pin and an unpinned agent without a replacement", () => {
    funnel.spawnTopLevel({}, funnelCtx(), "inscope", "go", { description: "d" });
    funnel.spawnTopLevel({}, funnelCtx(), "plain", "go", { description: "d" });
    expect(spawn.mock.calls[0][4].modelReplaced).toBeUndefined();
    expect(spawn.mock.calls[1][4].modelReplaced).toBeUndefined();
    expect(spawn.mock.calls[1][4].model).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses a caller-supplied out-of-scope model and lists the allowed ones", () => {
    expect(() => funnel.spawnTopLevel({}, funnelCtx(), "plain", "go", { description: "d", model: MODELS[0] }))
      .toThrow(/Accepted models[\s\S]*anthropic\/claude-haiku-4-5/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never examines an out-of-scope session model", () => {
    funnel.spawnTopLevel({}, { ...funnelCtx(), model: OPUS }, "plain", "go", { description: "d" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("bounds nothing while the setting is off", () => {
    setScopeModelsEnabled(false);
    funnel.spawnTopLevel({}, funnelCtx(), "pinned", "go", { description: "d" });
    expect(spawn.mock.calls[0][4].modelReplaced).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports modelReplaced in the agent:rpc:spawn reply and refuses a caller model", async () => {
    const records = new Map<string, any>();
    const handlers = new Map<string, (raw: any) => unknown>();
    const replies: Array<{ channel: string; data: any }> = [];
    spawn.mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      records.set("id-1", { modelReplaced: options.modelReplaced });
      return "id-1";
    });
    registerRpcHandlers({
      events: {
        on: (channel: string, fn: (raw: any) => unknown) => {
          handlers.set(channel, fn);
          return () => {};
        },
        emit: (channel: string, data: unknown) => replies.push({ channel, data }),
      },
      pi: {},
      getCtx: () => funnelCtx() as never,
      manager: {
        spawn: funnel.spawnTopLevel,
        awaitStartup: async () => {},
        getRecord: id => records.get(id),
        abort: () => false,
        consumeResult: () => false,
      },
    });

    await handlers.get("agent:rpc:spawn")?.({ requestId: "a", type: "pinned", prompt: "go", options: { description: "d" } });
    await handlers.get("agent:rpc:spawn")?.({ requestId: "b", type: "plain", prompt: "go", options: { description: "d" } });
    await handlers.get("agent:rpc:spawn")?.({ requestId: "c", type: "plain", prompt: "go", options: { description: "d", model: "anthropic/claude-opus-4-6" } });

    const reply = (id: string) => replies.find(r => r.channel === `agent:rpc:spawn:reply:${id}`)?.data;
    expect(reply("a")).toEqual({ success: true, data: { id: "id-1", modelReplaced: "anthropic/claude-opus-4-6" } });
    expect(reply("b")).toEqual({ success: true, data: { id: "id-1" } });
    expect(reply("c").success).toBe(false);
    expect(reply("c").error).toContain("Accepted models");
  });
});

const findingRegistry = {
  getAll: () => MODELS,
  getAvailable: () => MODELS,
  find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
};

describe("resolvePinnedModel", () => {
  it("returns no pin when no model input", () => {
    expect(resolvePinnedModel({ modelInput: undefined, modelFromParams: false }, { cwd: process.cwd(), modelRegistry: findingRegistry })).toEqual({ ok: true, pinned: undefined });
  });

  it("resolves a known model", () => {
    const r = resolvePinnedModel({ modelInput: "anthropic/claude-opus-4-6", modelFromParams: true }, { cwd: process.cwd(), modelRegistry: findingRegistry });
    expect(r).toMatchObject({ ok: true, pinned: OPUS });
  });

  it("refuses an unresolved model that came from params", () => {
    const r = resolvePinnedModel({ modelInput: "nope/none", modelFromParams: true }, { cwd: process.cwd(), modelRegistry: findingRegistry });
    expect(r).toEqual({ ok: false, message: expect.any(String) });
  });

  it("returns no pin when an unresolved model came from config", () => {
    const r = resolvePinnedModel({ modelInput: "nope/none", modelFromParams: false }, { cwd: process.cwd(), modelRegistry: findingRegistry });
    expect(r).toEqual({ ok: true, pinned: undefined });
  });

  it("treats a blank caller input as absent, even when it came from params", () => {
    const r = resolvePinnedModel({ modelInput: "   ", modelFromParams: true }, { cwd: process.cwd(), modelRegistry: findingRegistry });
    expect(r).toEqual({ ok: true, pinned: undefined });
  });
});

describe("resolveScopedModel", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
    setScopeModelsEnabled(true);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }));
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function resolve(modelInput: string | undefined, modelFromParams: boolean, notify = vi.fn()) {
    const result = resolveScopedModel(
      { modelInput, modelFromParams },
      { sessionModel: HAIKU as never, cwd: projectDir, modelRegistry: findingRegistry, notify },
      "scout",
    );
    return { result, notify };
  }

  it("refuses an unresolved model from params before checking scope", () => {
    const { result, notify } = resolve("nope/none", true);
    expect(result.ok).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope model from params", () => {
    const { result } = resolve("anthropic/claude-opus-4-6", true);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("Accepted models") });
  });

  it("replaces an out-of-scope pin with the session model and warns", () => {
    const { result, notify } = resolve("anthropic/claude-opus-4-6", false);
    expect(result).toEqual({ ok: true, model: HAIKU, replaced: "anthropic/claude-opus-4-6" });
    expect(notify).toHaveBeenCalledWith(
      'Agent "scout" pins out-of-scope model "anthropic/claude-opus-4-6"; using the session model instead',
      "warning",
    );
  });

  it("keeps an in-scope pin without a warning", () => {
    const { result, notify } = resolve("anthropic/claude-haiku-4-5", true);
    expect(result).toMatchObject({ ok: true, model: HAIKU, replaced: undefined });
    expect(notify).not.toHaveBeenCalled();
  });

  it("resolves a shorthand that is unique in scope", () => {
    const pool = [
      { provider: "anthropic", id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4-6"] }));
    const registry = {
      getAll: () => pool,
      getAvailable: () => pool,
      find: (provider: string, id: string) => pool.find(m => m.provider === provider && m.id === id),
    };
    const result = resolveScopedModel(
      { modelInput: "sonnet", modelFromParams: true },
      { sessionModel: HAIKU as never, cwd: projectDir, modelRegistry: registry, notify: vi.fn() },
      "scout",
    );
    expect(result).toMatchObject({ ok: true, model: pool[1] });
  });

  it("refuses a shorthand when scope holds no candidate", () => {
    const pool = [
      { provider: "anthropic", id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];
    const registry = {
      getAll: () => pool,
      getAvailable: () => pool,
      find: (provider: string, id: string) => pool.find(m => m.provider === provider && m.id === id),
    };
    const result = resolveScopedModel(
      { modelInput: "sonnet", modelFromParams: true },
      { sessionModel: HAIKU as never, cwd: projectDir, modelRegistry: registry, notify: vi.fn() },
      "scout",
    );
    expect(result.ok).toBe(false);
  });
});

describe("acceptedModels", () => {
  const catalog = { getAll: () => MODELS, getAvailable: () => MODELS, find: () => undefined };

  it("lists every available model, sorted, when no scope applies", () => {
    expect(acceptedModels(undefined, catalog)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("treats an empty scope as no scope", () => {
    expect(acceptedModels(new Set<string>(), catalog)).toEqual(acceptedModels(undefined, catalog));
  });

  it("lists only the scoped set, sorted, as indented provider/id lines", () => {
    expect(acceptedModelLines(["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"], catalog))
      .toBe("  anthropic/claude-haiku-4-5\n  anthropic/claude-sonnet-4-6");
  });
});

describe("acceptedModels under the model scope setting", () => {
  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;

  const catalog = { getAll: () => MODELS, getAvailable: () => MODELS, find: () => undefined };

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-accepted-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-accepted-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function setEnabledModels(models: string[]) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: models }));
  }

  function accepted(): string[] {
    return acceptedModels(modelScope(projectDir, catalog), catalog);
  }

  it("lists the scoped set when the setting is on and enabledModels resolves", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(accepted()).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("lists the full catalog when the setting is off", () => {
    setScopeModelsEnabled(false);
    setEnabledModels(["anthropic/claude-haiku-4-5"]);
    expect(accepted()).toEqual(acceptedModels(undefined, catalog));
  });

  it("lists the full catalog when enabledModels is missing", () => {
    setScopeModelsEnabled(true);
    expect(accepted()).toEqual(acceptedModels(undefined, catalog));
  });

  it("lists the full catalog when enabledModels resolves to nothing usable", () => {
    setScopeModelsEnabled(true);
    setEnabledModels(["anthropic/*", "haiku"]);
    expect(accepted()).toEqual(acceptedModels(undefined, catalog));
  });
});
