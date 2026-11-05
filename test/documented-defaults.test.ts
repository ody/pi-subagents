import { beforeEach, describe, expect, it, vi } from "vitest";

describe("documented defaults (README:441)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const HEAVY_REIMPORT_MS = 60_000;

  it("grace turns after the soft limit default to 5", async () => {
    const { getGraceTurns } = await import("../src/config/runner-defaults.js");
    expect(getGraceTurns()).toBe(5);
  }, HEAVY_REIMPORT_MS);

  it("max turns is unlimited by default", async () => {
    const { getDefaultMaxTurns } = await import("../src/config/runner-defaults.js");
    expect(getDefaultMaxTurns()).toBeUndefined();
  }, HEAVY_REIMPORT_MS);

  it("nested subagent depth defaults to 2", async () => {
    const { getMaxSubagentDepth } = await import("../src/tool/nested-tools.js");
    expect(getMaxSubagentDepth()).toBe(2);
  });

  it("background concurrency defaults to 10", async () => {
    const { AgentManager } = await import("../src/manager/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrent()).toBe(10);
    } finally {
      manager.dispose();
    }
  });

  it("foreground concurrency is unlimited by default", async () => {
    const { AgentManager } = await import("../src/manager/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrentForeground()).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it("top-level spawns default to background, nested spawns to foreground", async () => {
    const { resolveAgentInvocationConfig } = await import("../src/tool/invocation-config.js");
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: true }).runInBackground).toBe(true);
    expect(resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: false }).runInBackground).toBe(false);
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: false }, { defaultRunInBackground: true }).runInBackground).toBe(false);
    expect(resolveAgentInvocationConfig(undefined, { run_in_background: true }, { defaultRunInBackground: false }).runInBackground).toBe(true);
  });

  it("model scope is off by default", async () => {
    const { isScopeModelsEnabled } = await import("../src/config/model-scope.js");
    expect(isScopeModelsEnabled()).toBe(false);
  });
});
