import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { setScopeModelsEnabled } from "../src/config/model-scope.js";
import { detailBaseFor, resolveAgentCall } from "../src/tool/agent-call-resolution.js";
import type { AgentRecord } from "../src/types.js";
import { testAgent, testAgents } from "./helpers/test-agents.js";

const base = {
  displayName: "Explore",
  description: "scan repo",
  subagentType: "Explore",
  modelName: "haiku",
  tags: ["background"],
};

const ctx = {
  model: undefined,
  cwd: "/tmp",
  modelRegistry: { getAvailable: () => [], getAll: () => [] },
  ui: { notify: () => {} },
} as unknown as Parameters<typeof resolveAgentCall>[1];

const opts = { worktreeAllowed: true, defaultRunInBackground: true };

describe("detailBaseFor", () => {
  it("returns the request-time base when there is no record", () => {
    expect(detailBaseFor(base, undefined)).toBe(base);
  });

  it("returns the request-time base when the record has no invocation", () => {
    const rec = { type: "Explore", description: "x" } as AgentRecord;
    expect(detailBaseFor(base, rec)).toBe(base);
  });

  it("rebuilds from the record's own invocation and type", () => {
    const rec = {
      type: "Explore",
      description: "from record",
      invocation: { modelName: "sonnet", thinking: "high", runInBackground: false },
    } as AgentRecord;
    const out = detailBaseFor(base, rec);
    expect(out.description).toBe("from record");
    expect(out.subagentType).toBe("Explore");
    expect(out.modelName).toBe("sonnet");
    expect(out.tags).toContain("thinking: high");
    expect(out.tags).not.toContain("background");
  });
});

describe("resolveAgentCall", () => {
  beforeEach(() => {
    registerAgents(testAgents("Explore"));
  });
  afterEach(() => {
    registerAgents(new Map());
  });

  it("resolves a known type with defaults applied", () => {
    const out = resolveAgentCall({ subagent_type: "Explore", description: "scan", prompt: "go" } as never, ctx, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subagentType).toBe("Explore");
    expect(out.runInBackground).toBe(true);
    expect(out.detailBase.description).toBe("scan");
    expect(out.detailBase.subagentType).toBe("Explore");
  });

  it("honors defaultRunInBackground: false", () => {
    const out = resolveAgentCall(
      { subagent_type: "Explore", description: "scan", prompt: "go" } as never,
      ctx,
      { ...opts, defaultRunInBackground: false },
    );
    expect(out.ok && out.runInBackground).toBe(false);
  });

  it("refuses an unknown type, lists the enabled types, and suggests omitting the type", () => {
    const out = resolveAgentCall({ subagent_type: "nope", description: "d", prompt: "p" } as never, ctx, opts);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('Unknown or disabled agent type: "nope"');
    expect(out.message).toContain("Available:");
    expect(out.message).toContain("Omit subagent_type");
  });

  it("does not gate an unknown type when resuming", () => {
    const out = resolveAgentCall(
      { subagent_type: "nope", description: "d", prompt: "p", resume: "abc" } as never,
      ctx,
      opts,
    );
    expect(out.ok).toBe(true);
  });

  describe("model scope", () => {
    const MODELS = [
      { id: "allowed", name: "Allowed", provider: "anthropic" },
      { id: "blocked", name: "Blocked", provider: "anthropic" },
    ];
    const session = { provider: "anthropic", id: "allowed" };
    let dir: string;
    let agentDir: string;
    let prevAgentDir: string | undefined;
    let notices: string[];
    let scopedCtx: Parameters<typeof resolveAgentCall>[1];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "call-scope-"));
      agentDir = mkdtempSync(join(tmpdir(), "call-scope-global-"));
      prevAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      mkdirSync(join(dir, ".pi"), { recursive: true });
      writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/allowed"] }));
      setScopeModelsEnabled(true);
      notices = [];
      scopedCtx = {
        model: session,
        cwd: dir,
        modelRegistry: {
          find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
          getAvailable: () => MODELS,
          getAll: () => MODELS,
        },
        ui: { notify: (message: string) => notices.push(message) },
      } as unknown as Parameters<typeof resolveAgentCall>[1];
      registerAgents(new Map([["pinned", testAgent("pinned", { model: "anthropic/blocked" })], ["ghost", testAgent("ghost", { model: "nope/none" })]]));
    });
    afterEach(() => {
      setScopeModelsEnabled(false);
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });

    it("replaces an out-of-scope file pin with the session model and notifies", () => {
      const out = resolveAgentCall({ subagent_type: "pinned", description: "d", prompt: "p" } as never, scopedCtx, opts);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.model).toBe(session);
      expect(out.modelReplaced).toBe("anthropic/blocked");
      expect(notices).toHaveLength(1);
    });

    it("never examines the session model when the pin fails to resolve", () => {
      const out = resolveAgentCall({ subagent_type: "ghost", description: "d", prompt: "p" } as never, { ...scopedCtx, model: { provider: "anthropic", id: "blocked" } } as never, opts);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.modelReplaced).toBeUndefined();
      expect(notices).toEqual([]);
    });

    it("skips the check on resume", () => {
      const out = resolveAgentCall({ subagent_type: "pinned", description: "d", prompt: "p", resume: "abc" } as never, scopedCtx, opts);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.modelReplaced).toBeUndefined();
      expect(notices).toEqual([]);
    });
  });
});
