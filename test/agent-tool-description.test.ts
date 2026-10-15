import { describe, expect, it } from "vitest";
import { buildAgentToolDescription, firstSentence, formatToolsSuffix } from "../src/agent-tool-description.js";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { getModelLabelFromConfig } from "../src/model-resolver.js";
import type { AgentConfig } from "../src/types.js";

const cfg = (over: Partial<AgentConfig>) => over as AgentConfig;

describe("formatToolsSuffix", () => {
  it("renders * for an unknown or un-narrowed agent", () => {
    expect(formatToolsSuffix(undefined)).toBe("*");
    expect(formatToolsSuffix(cfg({}))).toBe("*");
  });

  it("renders * for the full built-in set", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [...BUILTIN_TOOL_NAMES] }))).toBe("*");
  });

  it("lists a narrowed set", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: ["read", "grep"] }))).toBe("read, grep");
  });

  it("renders none only when the agent can call nothing", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], isolated: true }))).toBe("none");
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], extensions: false }))).toBe("none");
  });

  it("renders extension-only agents honestly", () => {
    expect(formatToolsSuffix(cfg({ builtinToolNames: [], extensions: true }))).toBe("no built-ins, extension tools only");
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end", () => {
    expect(firstSentence("Does a thing. Then more.")).toBe("Does a thing.");
  });

  it("keeps text with no terminator and collapses whitespace", () => {
    expect(firstSentence("no  terminator\nhere")).toBe("no terminator here");
  });

  it("does not cut inside a dotted token", () => {
    expect(firstSentence("Reads v1.2 files. Done.")).toBe("Reads v1.2 files.");
  });
});

describe("getModelLabelFromConfig", () => {
  it("strips the provider prefix and date suffix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(getModelLabelFromConfig("sonnet")).toBe("sonnet");
  });
});

describe("buildAgentToolDescription", () => {
  const base = { mode: "full", schedulingEnabled: true, worktreeEnabled: true } as const;

  it("gates the schedule and isolation guidelines", () => {
    const on = buildAgentToolDescription(base);
    expect(on).toContain("Use `schedule` only");
    expect(on).toContain('Use isolation: "worktree"');
    const off = buildAgentToolDescription({ ...base, schedulingEnabled: false, worktreeEnabled: false });
    expect(off).not.toContain("Use `schedule` only");
    expect(off).not.toContain("isolation:");
  });

  it("compact is shorter than full", () => {
    expect(buildAgentToolDescription({ ...base, mode: "compact" }).length).toBeLessThan(buildAgentToolDescription(base).length);
  });
});
