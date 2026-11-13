import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../src/platform/worktree.js";
import { createNestedSubagentTools } from "../src/tool/nested-tools.js";
import { createSpawnFunnel } from "../src/triggers/spawn-funnel.js";
import { grant } from "./helpers/capability.js";

let cwd: string;
let savedSwitch: boolean;

function writeAgent(name: string, isolation?: "worktree" | "off") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const line = isolation ? `isolation: ${isolation}\n` : "";
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${line}---\n${name}\n`);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "wt-switch-paths-"));
  savedSwitch = isWorktreeIsolationEnabled();
  writeAgent("plain");
  writeAgent("walled", "worktree");
  writeAgent("open", "off");
  registerAgents(loadCustomAgents(cwd));
});

afterEach(() => {
  setWorktreeIsolationEnabled(savedSwitch);
  rmSync(cwd, { recursive: true, force: true });
});

describe("worktree switch on the spawn funnel", () => {
  function funnel() {
    const spawn = vi.fn(() => "agent-1");
    const created = createSpawnFunnel({
      manager: { spawn, getRecord: vi.fn(), resolveMention: vi.fn() } as any,
      reloadCustomAgents: () => {},
    });
    return { spawn, ...created };
  }

  const ctx = () => ({ cwd, ui: { notify: vi.fn() } });
  const isolationOf = (spawn: ReturnType<typeof vi.fn>) => (spawn.mock.calls[0] as unknown[])[4] as { isolation?: string };

  const paths = [
    ["top-level (registry, RPC, direct mention)", "spawnTopLevel"],
    ["resolved (mention resume)", "spawnResolved"],
  ] as const;

  describe.each(paths)("%s path", (_label, key) => {
    it("creates a worktree for a file's isolation: worktree when the switch is on", () => {
      setWorktreeIsolationEnabled(true);
      const f = funnel();

      f[key]({}, ctx(), "walled", "go", { description: "d" });

      expect(isolationOf(f.spawn).isolation).toBe("worktree");
    });

    it("lets a file's isolation: off override a caller's worktree request when the switch is on", () => {
      setWorktreeIsolationEnabled(true);
      const f = funnel();

      f[key]({}, ctx(), "open", "go", { description: "d", isolation: "worktree" });

      expect(isolationOf(f.spawn).isolation).toBeUndefined();
    });

    it("keeps a caller's worktree request for a file that is silent when the switch is on", () => {
      setWorktreeIsolationEnabled(true);
      const f = funnel();

      f[key]({}, ctx(), "plain", "go", { description: "d", isolation: "worktree" });

      expect(isolationOf(f.spawn).isolation).toBe("worktree");
    });

    it("requests no worktree and does not refuse a file's isolation: worktree when the switch is off", () => {
      setWorktreeIsolationEnabled(false);
      const f = funnel();

      expect(() => f[key]({}, ctx(), "walled", "go", { description: "d" })).not.toThrow();

      expect(isolationOf(f.spawn).isolation).toBeUndefined();
    });

    it("requests no worktree and does not refuse a caller's worktree request when the switch is off", () => {
      setWorktreeIsolationEnabled(false);
      const f = funnel();

      expect(() => f[key]({}, ctx(), "plain", "go", { description: "d", isolation: "worktree" })).not.toThrow();

      expect(isolationOf(f.spawn).isolation).toBeUndefined();
    });
  });

  it("downgrades an inline agent's isolation when the switch is off and honors it when on", () => {
    const inline = { name: "inline", description: "inline", systemPrompt: "x", isolation: "worktree" } as any;

    setWorktreeIsolationEnabled(false);
    const off = funnel();
    off.spawnTopLevel({}, ctx(), "inline", "go", { description: "d", agentConfig: inline });
    expect(isolationOf(off.spawn).isolation).toBeUndefined();

    setWorktreeIsolationEnabled(true);
    const on = funnel();
    on.spawnTopLevel({}, ctx(), "inline", "go", { description: "d", agentConfig: inline });
    expect(isolationOf(on.spawn).isolation).toBe("worktree");
  });
});

describe("worktree switch on the nested path", () => {
  function nestedAgentTool() {
    const spawnAndWait = vi.fn(async () => ({ id: "child-1", record: { id: "child-1", status: "completed", result: "done" } }));
    const manager = {
      spawn: vi.fn(() => "child-1"),
      spawnAndWait,
      awaitStartup: vi.fn(async () => {}),
      getRecord: (id: string) => ({ id, capabilities: grant().capabilities }),
      resume: vi.fn(),
      abort: vi.fn(),
    } as any;
    const [agent] = createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: cwd,
    });
    const execute = (params: Record<string, unknown>) =>
      agent.execute("call-1", { description: "d", prompt: "p", ...params } as any, undefined, undefined, {
        cwd,
        ui: { notify: vi.fn() },
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent"),
      } as any);
    return { spawnAndWait, execute };
  }

  const optionsOf = (spawnAndWait: ReturnType<typeof vi.fn>) => (spawnAndWait.mock.calls[0] as unknown[])[4] as { isolation?: string };

  it("creates a worktree for a file's isolation: worktree when the switch is on", async () => {
    setWorktreeIsolationEnabled(true);
    const { spawnAndWait, execute } = nestedAgentTool();

    await execute({ subagent_type: "walled" });

    expect(optionsOf(spawnAndWait).isolation).toBe("worktree");
  });

  it("lets a file's isolation: off override a caller's worktree request when the switch is on", async () => {
    setWorktreeIsolationEnabled(true);
    const { spawnAndWait, execute } = nestedAgentTool();

    await execute({ subagent_type: "open", isolation: "worktree" });

    expect(optionsOf(spawnAndWait).isolation).toBeUndefined();
  });

  it("requests no worktree and does not refuse when the switch is off", async () => {
    setWorktreeIsolationEnabled(false);
    const { spawnAndWait, execute } = nestedAgentTool();

    const result = await execute({ subagent_type: "walled", isolation: "worktree" });

    expect(result.isError).toBe(false);
    expect(optionsOf(spawnAndWait).isolation).toBeUndefined();
  });
});
