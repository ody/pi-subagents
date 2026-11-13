import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_KEYS, SETTING_SPECS, type SettingSpec } from "../src/config/settings-defaults.js";

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

  it("runtime defaults equal the defaults table", async () => {
    const { SETTING_SPECS } = await import("../src/config/settings-defaults.js");
    const { getGraceTurns, getRememberAgents } = await import("../src/config/runner-defaults.js");
    const { getMaxSubagentDepth } = await import("../src/tool/nested-tools.js");
    const { getOutputTranscriptDefault } = await import("../src/platform/output-file.js");
    const { isWorktreeIsolationEnabled } = await import("../src/platform/worktree.js");
    expect(getGraceTurns()).toBe(SETTING_SPECS.graceTurns.default);
    expect(getRememberAgents()).toBe(SETTING_SPECS.rememberAgents.default);
    expect(getMaxSubagentDepth()).toBe(SETTING_SPECS.maxSubagentDepth.default);
    expect(getOutputTranscriptDefault()).toBe(SETTING_SPECS.outputTranscript.default);
    expect(isWorktreeIsolationEnabled()).toBe(SETTING_SPECS.worktreeIsolation.default);
  }, HEAVY_REIMPORT_MS);
});

describe("README settings table", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Persistent Settings"), readme.indexOf("Two files, merged on load"));
  const rows = [...section.matchAll(/^\| `(\w+)` \| (.+?) \| `(.+?)` \|$/gm)].map((m) => ({
    key: m[1],
    values: m[2],
    def: m[3],
  }));

  it("lists every settings key once", () => {
    expect(rows.map((r) => r.key).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it.each(SETTING_KEYS)("%s matches the table", (key) => {
    const row = rows.find((r) => r.key === key);
    const spec = SETTING_SPECS[key] as SettingSpec;
    expect(row?.def).toBe(String(spec.default));
    if (spec.kind === "integer") expect(row?.values).toContain(`${spec.min}–${spec.max}`);
    if (spec.kind === "enum") for (const value of spec.values) expect(row?.values).toContain(`\`${value}\``);
    if (spec.kind === "boolean") expect(row?.values).toBe("boolean");
  });

  it("states the widgetMode default once, as all", () => {
    expect(readme).not.toContain("`background` (default");
    expect(readme).not.toContain("(`widgetMode: background`)");
  });
});
