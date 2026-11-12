import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { detailBaseFor, resolveAgentCall } from "../src/tool/agent-call-resolution.js";
import type { AgentRecord } from "../src/types.js";
import { testAgents } from "./helpers/test-agents.js";

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
});
