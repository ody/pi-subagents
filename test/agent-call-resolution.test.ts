import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detailBaseFor, resolveAgentCall } from "../src/agent-call-resolution.js";
import { registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import type { AgentRecord } from "../src/types.js";

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
    registerAgents(new Map());
    setFallbackSubagent(undefined);
  });
  afterEach(() => {
    registerAgents(new Map());
    setFallbackSubagent(undefined);
  });

  it("resolves a known type with defaults applied", () => {
    const out = resolveAgentCall({ subagent_type: "Explore", description: "scan", prompt: "go" } as never, ctx, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subagentType).toBe("Explore");
    expect(out.requestedType).toBe("Explore");
    expect(out.fallbackNote).toBe("");
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

  it("falls back for an unknown type by default and says so", () => {
    const out = resolveAgentCall({ subagent_type: "nope", description: "d", prompt: "p" } as never, ctx, opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subagentType).toBe("general-purpose");
    expect(out.requestedType).toBe("nope");
    expect(out.fallbackNote).toContain('Unknown agent type "nope"');
  });

  it("refuses an unknown type before anything spawns when fallbackSubagent is none", () => {
    setFallbackSubagent("none");
    const out = resolveAgentCall({ subagent_type: "nope", description: "d", prompt: "p" } as never, ctx, opts);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("nope");
  });

  it("does not gate an unknown type when resuming", () => {
    setFallbackSubagent("none");
    const out = resolveAgentCall(
      { subagent_type: "nope", description: "d", prompt: "p", resume: "abc" } as never,
      ctx,
      opts,
    );
    expect(out.ok).toBe(true);
  });
});
