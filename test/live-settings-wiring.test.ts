import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ menu: undefined as any, settingsDeps: undefined as any }));

vi.mock("../src/ui/agents-menu.js", () => ({
  registerAgentsCommand: (_pi: unknown, deps: unknown) => { captured.menu = deps; },
}));
vi.mock("../src/ui/settings-menu.js", () => ({
  showSettings: async (_ctx: unknown, deps: unknown) => { captured.settingsDeps = deps; },
}));

import subagentsExtension from "../src/index.js";

function runInBackgroundDescription(tools: Map<string, any>): string {
  return tools.get("agent").parameters.properties.run_in_background.description;
}

describe("live settings wiring", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let tools: Map<string, any>;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-live-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-live-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);

    tools = new Map();
    const handlers = new Map<string, any>();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => { handlers.set(event, handler); }),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    subagentsExtension(pi);
    shutdown = async () => { await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} }); };
  });

  afterEach(async () => {
    await shutdown?.();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("re-registers the agent tool with the new run_in_background description", async () => {
    expect(runInBackgroundDescription(tools)).toMatch(/^Defaults to true/);
    const ctx = { ui: { notify: vi.fn() } } as any;
    await captured.menu.showSettings(ctx);
    captured.settingsDeps.settingsPersist.persist(ctx, "x", { layer: "project", key: "backgroundByDefault", value: false });
    expect(runInBackgroundDescription(tools)).toMatch(/^Defaults to false/);
    captured.settingsDeps.settingsPersist.persist(ctx, "x", { layer: "project", key: "backgroundByDefault", value: true });
    expect(runInBackgroundDescription(tools)).toMatch(/^Defaults to true/);
  });

});
