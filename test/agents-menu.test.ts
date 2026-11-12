import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personalAgentsDir } from "../src/agents/agent-file-toggle.js";
import { registerAgents } from "../src/agents/agent-types.js";
import { loadCustomAgents } from "../src/agents/custom-agents.js";
import type { AgentConfig } from "../src/types.js";
import { type AgentsCommandDeps, detailMenuOptions, registerAgentsCommand } from "../src/ui/agents-menu.js";

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
    manager: { listAgents: () => [], getActivity: () => undefined },
    reloadCustomAgents: (strict?: boolean) => registerAgents(loadCustomAgents(cwd, strict)),
    settings: { showCost: false, viewerMarkdown: "all" },
    chooseViewerMarkdown: () => {},
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
