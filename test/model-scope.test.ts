import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import type { ModelRegistryRef } from "../src/config/enabled-models.js";
import { checkModelScope, isScopeModelsEnabled, scopeModel, setScopeModelsEnabled } from "../src/config/model-scope.js";
import { createSpawnFunnel } from "../src/triggers/spawn-funnel.js";
import { testAgent } from "./helpers/test-agents.js";

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
      .toThrow(/Allowed models[\s\S]*anthropic\/claude-haiku-4-5/);
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

  it("drops a caller-forged modelReplaced from top-level options", () => {
    funnel.spawnTopLevel({}, funnelCtx(), "plain", "go", { description: "d", modelReplaced: "forged" });
    expect(spawn.mock.calls[0][4].modelReplaced).toBeUndefined();
  });
});
