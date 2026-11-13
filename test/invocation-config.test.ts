import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../src/tool/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers tool-call params over agent config for the four overridable fields and keeps the rest fill-only", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
        isolation: "worktree",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        max_turns: 1,
        inherit_context: true,
        run_in_background: true,
        isolated: true,
        isolation: "worktree",
      },
    );

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(1);
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(false);
    expect(resolved.isolation).toBe("worktree");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
      run_in_background: true,
      isolated: true,
      isolation: "worktree",
    });

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
    expect(resolved.isolation).toBe("worktree");
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
        isolated: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
  });

  it('collapses a param isolation of "off" to undefined', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "off" });
    expect(resolved.isolation).toBeUndefined();
  });

  it('lets a config isolation of "off" veto a param "worktree"', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "off" }), { isolation: "worktree" });
    expect(resolved.isolation).toBeUndefined();
  });

  it('still honours a param "worktree" when the config leaves isolation unset', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "worktree" });
    expect(resolved.isolation).toBe("worktree");
  });

  it("drops worktree isolation when the project disallows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), { isolation: "worktree" }, { worktreeAllowed: false });
    expect(resolved.isolation).toBeUndefined();
  });

  it("keeps worktree isolation when the project allows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), {}, { worktreeAllowed: true });
    expect(resolved.isolation).toBe("worktree");
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for foreground agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});

describe("resolveAgentInvocationConfig — overridden params (#182)", () => {
  it("records the losing side of each disagreement", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model", thinking: "low" }),
      { model: "provider/param-model", thinking: "max" },
    );

    expect(resolved.overridden).toEqual({
      thinking: "low",
      model: "provider/config-model",
      maxTurns: undefined,
      runInBackground: undefined,
    });
  });

  it("lets a caller-supplied model beat a frontmatter pin", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model" }),
      { model: "provider/param-model" },
    );

    expect(resolved.modelInput).toBe("provider/param-model");
  });

  it("reports a winning caller model as caller-supplied even against a pin", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model" }),
      { model: "provider/param-model" },
    );

    expect(resolved.modelFromParams).toBe(true);
  });

  it("lets the caller's thinking level outrank the file's", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ thinking: "low" }),
      { thinking: "max" },
    );

    expect(resolved.thinking).toBe("max");
  });

  it("falls back to the file's thinking, max_turns, and run_in_background when the caller is silent", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ thinking: "low", maxTurns: 20, runInBackground: true }),
      {},
      { defaultRunInBackground: false },
    );

    expect(resolved.thinking).toBe("low");
    expect(resolved.maxTurns).toBe(20);
    expect(resolved.runInBackground).toBe(true);
  });

  it("lets a caller run_in_background of false beat a file's true and the default", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ runInBackground: true }),
      { run_in_background: false },
      { defaultRunInBackground: true },
    );

    expect(resolved.runInBackground).toBe(false);
    expect(resolved.overridden?.runInBackground).toBe(true);
  });

  it("lets a caller run_in_background of true beat a file's false and a false default", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ runInBackground: false }),
      { run_in_background: true },
      { defaultRunInBackground: false },
    );

    expect(resolved.runInBackground).toBe(true);
    expect(resolved.overridden?.runInBackground).toBe(false);
  });

  it("lets a file's run_in_background of false beat a true default", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ runInBackground: false }),
      {},
      { defaultRunInBackground: true },
    );

    expect(resolved.runInBackground).toBe(false);
  });

  it("forces background without recording it as an override of the file's foreground", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ runInBackground: false }),
      {},
      { forceBackground: true },
    );

    expect(resolved.runInBackground).toBe(true);
    expect(resolved.overridden).toBeUndefined();
  });

  it("keeps a caller max_turns of 0 as an explicit unlimited over the file's limit", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ maxTurns: 20 }), { max_turns: 0 });

    expect(resolved.maxTurns).toBe(0);
    expect(resolved.overridden?.maxTurns).toBe(20);
  });

  it("records nothing when the caller got what they asked for", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/same", thinking: "high" }),
      { model: "provider/same", thinking: "high" },
    );

    expect(resolved.overridden).toBeUndefined();
  });

  it("records nothing when only one side named a value", () => {
    expect(resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model", thinking: "low" }),
      {},
    ).overridden).toBeUndefined();

    expect(resolveAgentInvocationConfig(
      makeConfig(),
      { model: "provider/param-model", thinking: "max" },
    ).overridden).toBeUndefined();
  });

  it("records each field independently", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ thinking: "low" }),
      { model: "provider/param-model", thinking: "max" },
    );

    expect(resolved.overridden).toEqual({
      thinking: "low",
      model: undefined,
      maxTurns: undefined,
      runInBackground: undefined,
    });
  });

  it("records the pin alone when only the model disagreed", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model" }),
      { model: "provider/param-model" },
    );

    expect(resolved.overridden).toEqual({
      thinking: undefined,
      model: "provider/config-model",
      maxTurns: undefined,
      runInBackground: undefined,
    });
  });
});
