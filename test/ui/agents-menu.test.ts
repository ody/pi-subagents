import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personalAgentsDir } from "../../src/agents/agent-file-toggle.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { loadCustomAgents } from "../../src/agents/custom-agents.js";
import { setScopeModelsEnabled } from "../../src/config/model-scope.js";
import type { AgentConfig, AgentRecord } from "../../src/types.js";
import { type AgentsCommandDeps, detailMenuOptions, modelLabelFor, registerAgentsCommand } from "../../src/ui/agents-menu.js";

const cfg = (over: Partial<AgentConfig>) => over as AgentConfig;

describe("detailMenuOptions", () => {
  it("skill source, enabled: eject and disable, regardless of file", () => {
    const expected = ["Eject (export as .md)", "Disable", "Back"];
    expect(detailMenuOptions(cfg({ source: "skill" }), false)).toEqual(expected);
    expect(detailMenuOptions(cfg({ source: "skill" }), true)).toEqual(expected);
  });

  it("skill source, disabled: eject only", () => {
    expect(detailMenuOptions(cfg({ source: "skill", enabled: false }), false)).toEqual(["Eject (export as .md)", "Back"]);
  });

  it("disabled agent with file offers enable, edit and delete", () => {
    expect(detailMenuOptions(cfg({ enabled: false }), true)).toEqual(["Enable", "Edit", "Delete", "Back"]);
  });

  it("custom agent", () => {
    expect(detailMenuOptions(cfg({}), true)).toEqual(["Edit", "Disable", "Delete", "Back"]);
  });
});

function runAgentsMenu(cwd: string, script: { selects: (string | undefined)[]; lists?: (string | undefined)[] }) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  registerAgentsCommand(pi, {
    manager: { listAgents: () => [], listTombstones: () => [] },
    reloadCustomAgents: (strict?: boolean) => registerAgents(loadCustomAgents(cwd, strict)),
    viewer: { open: async () => {} },
    showSettings: async () => {},
  } as unknown as AgentsCommandDeps);

  const pendingSelects = [...script.selects];
  const pendingLists = [...(script.lists ?? [])];
  const selectTitles: string[] = [];
  const ctx = {
    cwd,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    ui: {
      select: async (title: string) => {
        selectTitles.push(title);
        return pendingSelects.shift();
      },
      custom: async () => pendingLists.shift(),
      notify: () => {},
      confirm: async () => false,
      editor: async () => undefined,
    },
  };

  return {
    selectTitles,
    run: async () => {
      const command = commands.get("agents");
      if (!command) throw new Error("/agents was not registered");
      await command.handler("", ctx);
    },
  };
}

describe("modelLabelFor", () => {
  const MODELS = [
    { id: "claude-sonnet-4-5-20251001", name: "Claude Sonnet 4.5", provider: "anthropic" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  ];
  const registry = {
    getAll: () => MODELS,
    getAvailable: () => MODELS,
    find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
  };
  let dir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-menu-models-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-menu-models-agent-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(dir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    setScopeModelsEnabled(false);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("shows the resolved snapshot target for a shorthand pin", () => {
    expect(modelLabelFor(cfg({ model: "sonnet 4.5" }), { cwd: dir, modelRegistry: registry }))
      .toBe("sonnet 4.5 (→ anthropic/claude-sonnet-4-5-20251001)");
  });

  it("stays quiet when a full key resolves to itself", () => {
    expect(modelLabelFor(cfg({ model: "anthropic/claude-sonnet-4-6" }), { cwd: dir, modelRegistry: registry }))
      .toBe("claude-sonnet-4-6");
  });

  it("marks an unresolved pin as unavailable", () => {
    expect(modelLabelFor(cfg({ model: "missing" }), { cwd: dir, modelRegistry: registry }))
      .toBe("missing (unavailable, fallback: inherit)");
  });

  it("uses enabledModels to disambiguate a shorthand when scope is on", () => {
    setScopeModelsEnabled(true);
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-4-6"] }));
    expect(modelLabelFor(cfg({ model: "sonnet" }), { cwd: dir, modelRegistry: registry }))
      .toBe("sonnet (→ anthropic/claude-sonnet-4-6)");
  });
});

describe("/agents -> Agents", () => {
  it("opens the viewer through the shared function with the command ui and the record", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI;
    const record = { id: "a1", type: "general-purpose", description: "the one", status: "running", toolUses: 0, startedAt: Date.now() } as AgentRecord;
    const viewer = { open: vi.fn(async () => {}) };
    registerAgentsCommand(pi, {
      manager: { listAgents: () => [record], listTombstones: () => [], getActivity: () => undefined },
      reloadCustomAgents: () => {},
      viewer,
      showCost: () => false,
      showModel: () => false,
      showSettings: async () => {},
    });
    let selects = 0;
    let lists = 0;
    const ui = {
      select: async (_title: string, options: string[]) => (selects++ < 1 ? options[0] : undefined),
      custom: async (factory: (...args: unknown[]) => { handleInput(data: string): void }) => {
        if (lists++ > 0) return undefined;
        let chosen: unknown;
        const component = factory(
          { requestRender: () => {} },
          { fg: (_c: string, s: string) => s, bold: (s: string) => s },
          { matches: (_data: string, id: string) => id === "tui.select.confirm" },
          (value: unknown) => { chosen = value; },
        );
        component.handleInput("enter");
        return chosen;
      },
      notify: () => {},
    };

    await commands.get("agents")?.handler("", { cwd: "/", ui });

    expect(viewer.open).toHaveBeenCalledTimes(1);
    expect(viewer.open).toHaveBeenCalledWith(ui, { kind: "live", record });
  });
});

describe("/agents on a skill-embedded agent", () => {
  let tmpDir: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;

  const agentFile = [
    "---",
    "description: Scout the repo",
    "prompt_mode: append",
    "# the serializer drops comments and unknown keys",
    "hand_written: true",
    "---",
    "",
    "You are a scout.",
    "",
  ].join("\n");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-menu-"));
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    registerAgents(new Map());
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(): string {
    const skillDir = join(tmpDir, ".pi", "agent", "skills", "sdd");
    mkdirSync(join(skillDir, "agents"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: sdd\ndescription: test skill\n---\n");
    const agentPath = join(skillDir, "agents", "sdd-scout.md");
    writeFileSync(agentPath, agentFile);
    return agentPath;
  }

  const personalLocation = () => `Personal (${personalAgentsDir()})`;

  it("Eject writes the skill file verbatim to a user location", async () => {
    const skillPath = writeSkill();
    const menu = runAgentsMenu(tmpDir, {
      selects: ["Agent types (1)", "Eject (export as .md)", personalLocation(), undefined],
      lists: ["sdd-scout", undefined],
    });

    await menu.run();

    expect(menu.selectTitles).toEqual(["Agents", "sdd-scout", "Choose location", "Agents"]);
    const target = join(personalAgentsDir(), "sdd-scout.md");
    expect(readFileSync(target, "utf-8")).toBe(agentFile);
    expect(readFileSync(target, "utf-8")).toContain("hand_written: true");
    expect(readFileSync(skillPath, "utf-8")).toBe(agentFile);
  });

  it("Disable writes a user stub that shadows the skill agent", async () => {
    const skillPath = writeSkill();
    const menu = runAgentsMenu(tmpDir, {
      selects: ["Agent types (1)", "Disable", personalLocation(), undefined],
      lists: ["sdd-scout", undefined],
    });

    await menu.run();

    const stubPath = join(personalAgentsDir(), "sdd-scout.md");
    expect(readFileSync(stubPath, "utf-8")).toBe("---\nenabled: false\n---\n");

    const loaded = loadCustomAgents(tmpDir).get("sdd-scout");
    expect(loaded?.enabled).toBe(false);
    expect(loaded?.source).toBe("global");
    expect(loaded?.sourcePath).toBe(stubPath);
    expect(readFileSync(skillPath, "utf-8")).toBe(agentFile);
  });
});

function liveRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the live one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function finished(over: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle: "fixer",
    id: "h1",
    type: "general-purpose",
    description: "the finished one",
    sessionFile: "/sessions/h1.jsonl",
    completedAt: Date.now() - 60_000,
    status: "completed",
    ...over,
  };
}

function runAgentList(agents: AgentRecord[], tombstones: AgentTombstone[], downs = 0) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const viewer = { open: vi.fn(async () => {}) };
  registerAgentsCommand(pi, {
    manager: { listAgents: () => agents, listTombstones: () => tombstones, getActivity: () => undefined },
    reloadCustomAgents: () => {},
    viewer,
    showCost: () => false,
    showModel: () => false,
    showSettings: async () => {},
  });

  const selectOptions: string[][] = [];
  const lists: string[][] = [];
  let selects = 0;
  let customs = 0;
  const ui = {
    select: async (_title: string, options: string[]) => {
      selectOptions.push(options);
      return selects++ < 1 ? options[0] : undefined;
    },
    custom: async (factory: (...args: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) => {
      let chosen: unknown;
      const component = factory(
        { requestRender: () => {} },
        { fg: (_c: string, s: string) => s, bold: (s: string) => s },
        { matches: (_data: string, id: string) => id === "tui.select.confirm" },
        (value: unknown) => { chosen = value; },
      );
      lists.push(component.render(200));
      if (customs++ > 0) return undefined;
      for (let i = 0; i < downs; i++) component.handleInput("down");
      component.handleInput("enter");
      return chosen;
    },
    notify: () => {},
  };

  return {
    viewer,
    selectOptions,
    lists,
    run: async () => {
      const command = commands.get("agents");
      if (!command) throw new Error("/agents was not registered");
      await command.handler("", { cwd: "/", ui });
    },
  };
}

describe("/agents -> Agents history", () => {
  it("counts live rows and history rows separately in the menu header", async () => {
    const menu = runAgentList([liveRecord()], [finished({ handle: "one" }), finished({ handle: "two", id: "h2" })]);

    await menu.run();

    expect(menu.selectOptions[0][0]).toBe("Agents (1) — 1 running, 0 done · 2 in history");
  });

  it("reaches the list when only history rows exist", async () => {
    const menu = runAgentList([], [finished()]);

    await menu.run();

    expect(menu.selectOptions[0][0]).toBe("Agents (0) — 0 running, 0 done · 1 in history");
    expect(menu.lists[0].join("\n")).toContain("History");
  });

  it("lists the newest tombstone first", async () => {
    const older = finished({ handle: "older", id: "h-old", description: "older work", completedAt: Date.now() - 600_000 });
    const newer = finished({ handle: "newer", id: "h-new", description: "newer work", completedAt: Date.now() - 1000 });
    const menu = runAgentList([], [older, newer]);

    await menu.run();

    const rows = menu.lists[0].filter(line => line.includes("work"));
    expect(rows[0]).toContain("newer work");
    expect(rows[1]).toContain("older work");
  });

  it("opens a selected history row through the shared opener", async () => {
    const entry = finished();
    const menu = runAgentList([], [entry]);

    await menu.run();

    expect(menu.viewer.open).toHaveBeenCalledWith(expect.anything(), { kind: "history", entry });
  });

  it("skips a tombstone that still has a live record", async () => {
    const record = liveRecord({ id: "h1" });
    const menu = runAgentList([record], [finished({ id: "h1" })]);

    await menu.run();

    expect(menu.lists[0].join("\n")).not.toContain("History");
  });

  it("never lists a nested agent under History", async () => {
    const parent = liveRecord({ id: "p1", description: "parent job" });
    const child = liveRecord({ id: "c1", description: "child job", parentAgentId: "p1", status: "completed" });
    const menu = runAgentList([parent, child], []);

    await menu.run();

    const out = menu.lists[0].join("\n");
    expect(out).toContain("parent job");
    expect(out).toContain("child job");
    expect(out).not.toContain("History");
  });
});
