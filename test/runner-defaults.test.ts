import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-types.js", () => ({
  getAgentConfig: vi.fn(),
}));

import { getAgentConfig } from "../src/agent-types.js";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  resolveEffectiveMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/runner-defaults.js";

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    ...overrides,
  };
}

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("round-trips the value this suite set up", () => {
    // NOT a default assertion — the beforeEach above sets 5, so this only
    // proves the setter/getter pair agree. The real module default is asserted
    // against a freshly-imported module in test/documented-defaults.test.ts.
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});

// The limit a run will enforce, resolved before the run starts. The widget's
// turn counter has to predict it for agents spawned outside the Agent tool
// (mentions, cross-extension RPC), and a second copy of the expression there
// would drift from the one runAgent enforces — so both call this.
describe("resolveEffectiveMaxTurns", () => {
  let prevDefault: number | undefined;

  beforeEach(() => {
    prevDefault = getDefaultMaxTurns();
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig({ maxTurns: 7 }) as any);
  });

  afterEach(() => {
    setDefaultMaxTurns(prevDefault);
    vi.mocked(getAgentConfig).mockReset();
  });

  it("prefers an explicit value over the agent's own and the project default", () => {
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent", 3)).toBe(3);
  });

  it("falls back to the agent's own max_turns", () => {
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent")).toBe(7);
  });

  it("falls back to the project default when the agent sets none", () => {
    setDefaultMaxTurns(20);
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig() as any);
    expect(resolveEffectiveMaxTurns("test-agent")).toBe(20);
  });

  it("is unlimited when nothing sets a limit", () => {
    setDefaultMaxTurns(undefined);
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig() as any);
    expect(resolveEffectiveMaxTurns("test-agent")).toBeUndefined();
  });

  it("treats an explicit 0 as unlimited rather than as 'no opinion'", () => {
    // Not the same as omitting it: 0 is how a caller says "no limit", and
    // falling through to the default would impose one it asked not to have.
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent", 0)).toBeUndefined();
  });
});
