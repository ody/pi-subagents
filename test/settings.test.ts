import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAndEmitLoaded,
  applySettings,
  effectiveSettings,
  loadSettings,
  persistToastFor,
  type SettingsAppliers,
  saveAndEmitChanged,
} from "../src/config/settings.js";
import { SETTING_KEYS, SETTING_SPECS, type SettingSpec } from "../src/config/settings-defaults.js";
import { setLayerKey } from "../src/config/settings-store.js";

const NO_POLICY = { global: {}, project: {}, ephemeralNesting: true };

function saveSettings(s: Record<string, unknown>, cwd: string): boolean {
  const file = join(cwd, ".pi", "subagents.json");
  if (existsSync(file)) rmSync(file);
  return Object.entries(s).every(([key, value]) => setLayerKey("project", cwd, key, value).ok);
}

function spyAppliers(): SettingsAppliers {
  const calls = new Map<string | symbol, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get: (_t, name) => {
      if (!calls.has(name)) calls.set(name, vi.fn());
      return calls.get(name);
    },
  }) as SettingsAppliers;
}

describe("settings persistence", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeGlobal(obj: unknown) {
    writeFileSync(globalFile(), JSON.stringify(obj));
  }

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  it("returns {} when both files are missing", () => {
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("returns {} when both files are malformed JSON", () => {
    writeFileSync(globalFile(), "not json {{");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "also not json");
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("loads from global when no project file", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 10 });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 16, graceTurns: 10 });
  });

  it("loads from project when no global file", () => {
    writeProject({ maxConcurrent: 8, defaultJoinMode: "group" });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 8, defaultJoinMode: "group" });
  });

  it("merges global + project with project winning on conflicts", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 10, defaultJoinMode: "async" });
    writeProject({ maxConcurrent: 4, defaultMaxTurns: 50 });
    expect(loadSettings(projectDir)).toEqual({
      maxConcurrent: 4,
      graceTurns: 10,
      defaultJoinMode: "async",
      defaultMaxTurns: 50,
    });
  });

  it("round-trips values: saveSettings then loadSettings", () => {
    const settings = {
      maxConcurrent: 7,
      defaultMaxTurns: 30,
      graceTurns: 3,
      defaultJoinMode: "smart" as const,
      toolDescriptionMode: "compact" as const,
    };
    saveSettings(settings, projectDir);
    expect(loadSettings(projectDir)).toEqual(settings);
  });

  it("round-trips showModel, and absence stays absent", () => {
    saveSettings({}, projectDir);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips fleetView (true and false); keeps boolean, drops non-boolean", () => {
    saveSettings({ fleetView: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ fleetView: false });
    saveSettings({ fleetView: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ fleetView: true });
    writeProject({ fleetView: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips agentMentions modes; drops an unknown one", () => {
    for (const mode of ["model", "direct", "off"] as const) {
      saveSettings({ agentMentions: mode }, projectDir);
      expect(loadSettings(projectDir)).toEqual({ agentMentions: mode });
    }
    writeProject({ agentMentions: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("drops a boolean agentMentions", () => {
    writeProject({ agentMentions: true } as any);
    expect(loadSettings(projectDir)).toEqual({});
    writeProject({ agentMentions: false } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips rememberAgents (true and false); keeps boolean, drops non-boolean", () => {
    saveSettings({ rememberAgents: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ rememberAgents: false });
    saveSettings({ rememberAgents: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ rememberAgents: true });
    writeProject({ rememberAgents: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips widgetMode; keeps valid values, drops invalid", () => {
    saveSettings({ widgetMode: "off" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ widgetMode: "off" });
    saveSettings({ widgetMode: "background" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ widgetMode: "background" });
    writeProject({ widgetMode: "sideways" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips viewerMarkdown; keeps valid values, drops invalid", () => {
    saveSettings({ viewerMarkdown: "off" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ viewerMarkdown: "off" });
    saveSettings({ viewerMarkdown: "all" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ viewerMarkdown: "all" });
    writeProject({ viewerMarkdown: "markdown" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips outputTranscript; drops non-boolean", () => {
    saveSettings({ outputTranscript: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: false });
    saveSettings({ outputTranscript: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: true });
    writeProject({ outputTranscript: "no" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips backgroundByDefault (true and false), and absence stays absent", () => {
    saveSettings({ backgroundByDefault: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ backgroundByDefault: false });

    saveSettings({ backgroundByDefault: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ backgroundByDefault: true });

    saveSettings({}, projectDir);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("sanitize drops non-boolean backgroundByDefault silently", () => {
    writeProject({ backgroundByDefault: "yes" } as any);
    expect(loadSettings(projectDir)).toEqual({});
    writeProject({ backgroundByDefault: 0 } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips worktreeIsolation; drops non-boolean", () => {
    saveSettings({ worktreeIsolation: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ worktreeIsolation: false });
    saveSettings({ worktreeIsolation: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ worktreeIsolation: true });
    writeProject({ worktreeIsolation: "off" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips reportUsage and showCost; drops non-boolean", () => {
    saveSettings({ reportUsage: true, showCost: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ reportUsage: true, showCost: true });
    saveSettings({ reportUsage: false, showCost: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ reportUsage: false, showCost: false });
    writeProject({ reportUsage: "on", showCost: 1 } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips showModel; drops non-boolean", () => {
    saveSettings({ showModel: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ showModel: true });
    saveSettings({ showModel: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ showModel: false });
    writeProject({ showModel: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("saveSettings writes only to the project file; global is untouched", () => {
    writeGlobal({ maxConcurrent: 16 });
    saveSettings({ maxConcurrent: 2 }, projectDir);

    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16 });
  });

  it("saveSettings creates <cwd>/.pi/ when missing", () => {
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    saveSettings({ maxConcurrent: 4 }, projectDir);
    expect(existsSync(projectFile())).toBe(true);
  });

  it("round-trips defaultMaxTurns: 0 (unlimited marker)", () => {
    saveSettings({ defaultMaxTurns: 0 }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ defaultMaxTurns: 0 });
  });

  it("ignores unknown extra fields on load (forward-compat)", () => {
    writeProject({ maxConcurrent: 2, futureField: "ignored" });
    const loaded = loadSettings(projectDir);
    expect(loaded.maxConcurrent).toBe(2);
    expect((loaded as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("composes partial global + partial project correctly", () => {
    writeGlobal({ graceTurns: 10 });
    writeProject({ maxConcurrent: 2 });
    expect(loadSettings(projectDir)).toEqual({ graceTurns: 10, maxConcurrent: 2 });
  });

  describe("sanitizer", () => {
    it("drops maxConcurrent < 1", () => {
      writeProject({ maxConcurrent: 0, graceTurns: 5 });
      expect(loadSettings(projectDir)).toEqual({ graceTurns: 5 });
    });

    it("drops negative maxConcurrent", () => {
      writeProject({ maxConcurrent: -3 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops non-integer maxConcurrent (floats, NaN, strings)", () => {
      writeProject({ maxConcurrent: 3.5 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: "four" });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: null });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
    });

    it("keeps maxConcurrentForeground: 0 (explicit unlimited)", () => {
      writeProject({ maxConcurrentForeground: 0 });
      expect(loadSettings(projectDir)).toEqual({ maxConcurrentForeground: 0 });
    });

    it("drops out-of-range or non-integer maxConcurrentForeground", () => {
      for (const bad of [-1, 1025, 1.5, "four", null]) {
        writeProject({ maxConcurrentForeground: bad });
        expect(loadSettings(projectDir).maxConcurrentForeground).toBeUndefined();
      }
    });

    it("accepts defaultMaxTurns: 0 (explicit unlimited)", () => {
      writeProject({ defaultMaxTurns: 0 });
      expect(loadSettings(projectDir)).toEqual({ defaultMaxTurns: 0 });
    });

    it("drops negative defaultMaxTurns", () => {
      writeProject({ defaultMaxTurns: -1 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops graceTurns < 1", () => {
      writeProject({ graceTurns: 0 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("keeps maxSubagentDepth 0 (nesting off) but drops negative, fractional, and over-ceiling values", () => {
      writeProject({ maxSubagentDepth: 0 });
      expect(loadSettings(projectDir)).toEqual({ maxSubagentDepth: 0 });
      writeProject({ maxSubagentDepth: -1 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ maxSubagentDepth: 1.5 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ maxSubagentDepth: 17 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("ignores the removed fallbackSubagent and disableDefaultAgents keys", () => {
      writeProject({ fallbackSubagent: "none", disableDefaultAgents: true, maxConcurrent: 3 });
      expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 3 });
    });

    it("drops invalid defaultJoinMode values", () => {
      writeProject({ defaultJoinMode: "invalid" });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: 42 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: "" });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("accepts all three valid join modes", () => {
      for (const mode of ["async", "group", "smart"] as const) {
        writeProject({ defaultJoinMode: mode });
        expect(loadSettings(projectDir)).toEqual({ defaultJoinMode: mode });
      }
    });

    it("accepts scopeModels boolean (true and false)", () => {
      writeProject({ scopeModels: true });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: true });
      writeProject({ scopeModels: false });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: false });
    });

    it("accepts strictAgentFiles boolean (true and false)", () => {
      writeProject({ strictAgentFiles: true });
      expect(loadSettings(projectDir)).toEqual({ strictAgentFiles: true });
      writeProject({ strictAgentFiles: false });
      expect(loadSettings(projectDir)).toEqual({ strictAgentFiles: false });
    });

    it("drops non-boolean strictAgentFiles", () => {
      writeProject({ strictAgentFiles: "yes" });
      expect(loadSettings(projectDir).strictAgentFiles).toBeUndefined();
      writeProject({ strictAgentFiles: 1 });
      expect(loadSettings(projectDir).strictAgentFiles).toBeUndefined();
    });

    it("drops non-boolean scopeModels", () => {
      writeProject({ scopeModels: "yes" });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: 1 });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: null });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
    });

    it("accepts all valid toolDescriptionMode values", () => {
      for (const mode of ["full", "compact", "custom"] as const) {
        writeProject({ toolDescriptionMode: mode });
        expect(loadSettings(projectDir)).toEqual({ toolDescriptionMode: mode });
      }
    });

    it("drops invalid toolDescriptionMode", () => {
      writeProject({ toolDescriptionMode: "tiny" });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: true });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: null });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
    });

    it("returns {} when the JSON root is not an object (array, string, null)", () => {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), '["not", "an", "object"]');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), '"just a string"');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), "null");
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("keeps valid fields while dropping invalid siblings", () => {
      writeProject({
        maxConcurrent: 4,
        defaultMaxTurns: -5,
        graceTurns: 3,
        defaultJoinMode: "nope",
      });
      expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4, graceTurns: 3 });
    });

    it("accepts values at the ceiling (maxConcurrent=1024, defaultMaxTurns=10000, graceTurns=1000)", () => {
      writeProject({ maxConcurrent: 1024, defaultMaxTurns: 10_000, graceTurns: 1_000 });
      expect(loadSettings(projectDir)).toEqual({
        maxConcurrent: 1024,
        defaultMaxTurns: 10_000,
        graceTurns: 1_000,
      });
    });

    it("drops values above the ceiling", () => {
      writeProject({ maxConcurrent: 1025 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ defaultMaxTurns: 10_001 });
      expect(loadSettings(projectDir).defaultMaxTurns).toBeUndefined();
      writeProject({ graceTurns: 1_001 });
      expect(loadSettings(projectDir).graceTurns).toBeUndefined();
    });

    it("drops absurdly large values (e.g. 1e6)", () => {
      writeProject({ maxConcurrent: 1_000_000, defaultMaxTurns: 1_000_000, graceTurns: 1_000_000 });
      expect(loadSettings(projectDir)).toEqual({});
    });
  });

  describe("save result + corrupt-file warning", () => {
    it("saveSettings returns true on success", () => {
      expect(saveSettings({ maxConcurrent: 2 }, projectDir)).toBe(true);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    });

    it("saveSettings returns false when the target dir cannot be created", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        expect(saveSettings({ maxConcurrent: 1 }, filePosingAsCwd)).toBe(false);
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("warns to console.warn when an existing file is malformed", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), "not valid json {{{");
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toMatch(/Ignoring malformed settings/);
      } finally {
        spy.mockRestore();
      }
    });

    it("does NOT warn when a file is simply missing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("applySettings", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setMaxConcurrentForeground: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
      setRememberAgents: vi.fn(),
        setWidgetMode: vi.fn(),
        setViewerMarkdown: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
        setShowModel: vi.fn(),
      };
    });

    it("applies maxConcurrentForeground, including an explicit 0", () => {
      applySettings({ maxConcurrentForeground: 3 }, appliers);
      expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(3);

      applySettings({ maxConcurrentForeground: 0 }, appliers);
      expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(0);

      vi.mocked(appliers.setMaxConcurrentForeground).mockClear();
      applySettings({}, appliers);
      expect(appliers.setMaxConcurrentForeground).not.toHaveBeenCalled();
    });

    it("applies reportUsage and showCost", () => {
      applySettings({ reportUsage: true, showCost: true }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(true);
      expect(appliers.setShowCost).toHaveBeenCalledWith(true);

      applySettings({ reportUsage: false, showCost: false }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(false);
      expect(appliers.setShowCost).toHaveBeenCalledWith(false);
    });

    it("applies showModel", () => {
      applySettings({ showModel: true }, appliers);
      expect(appliers.setShowModel).toHaveBeenCalledWith(true);

      applySettings({ showModel: false }, appliers);
      expect(appliers.setShowModel).toHaveBeenCalledWith(false);
    });

    it("is a no-op on an empty settings object", () => {
      applySettings({}, appliers);
      expect(appliers.setReportUsage).not.toHaveBeenCalled();
      expect(appliers.setShowCost).not.toHaveBeenCalled();
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
      expect(appliers.setToolDescriptionMode).not.toHaveBeenCalled();
    });

    it("applies only the fields that are present", () => {
      applySettings({ maxConcurrent: 4, graceTurns: 3, maxSubagentDepth: 1 }, appliers);
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(4);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(3);
      expect(appliers.setMaxSubagentDepth).toHaveBeenCalledWith(1);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
    });

    it("applies all fields when all are present", () => {
      applySettings(
        {
          maxConcurrent: 8,
          defaultMaxTurns: 50,
          graceTurns: 7,
          defaultJoinMode: "group",
          scopeModels: true,
          toolDescriptionMode: "compact",
          fleetView: false,
          widgetMode: "off",
        },
        appliers,
      );
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(8);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(50);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("group");
      expect(appliers.setScopeModels).toHaveBeenCalledWith(true);
      expect(appliers.setStrictAgentFiles).not.toHaveBeenCalled();
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("compact");
      expect(appliers.setFleetView).toHaveBeenCalledWith(false);
      expect(appliers.setWidgetMode).toHaveBeenCalledWith("off");
    });

    it("applies strictAgentFiles; skips it when absent", () => {
      applySettings({ strictAgentFiles: true }, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledTimes(1);
    });

    it("applies widgetMode; skips it when absent", () => {
      applySettings({ widgetMode: "off" }, appliers);
      expect(appliers.setWidgetMode).toHaveBeenCalledWith("off");
      applySettings({}, appliers);
      expect(appliers.setWidgetMode).toHaveBeenCalledTimes(1);
    });

    it("applies viewerMarkdown; skips it when absent", () => {
      applySettings({ viewerMarkdown: "all" }, appliers);
      expect(appliers.setViewerMarkdown).toHaveBeenCalledWith("all");
      applySettings({}, appliers);
      expect(appliers.setViewerMarkdown).toHaveBeenCalledTimes(1);
    });

    it("applies fleetView (true and false); skips it when absent", () => {
      applySettings({ fleetView: true }, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledTimes(1);
    });

    it("applies agentMentions; skips it when absent", () => {
      applySettings({ agentMentions: "direct" }, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledWith("direct");
      applySettings({}, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledTimes(1);
    });

    it("applies rememberAgents; skips it when absent", () => {
      applySettings({ rememberAgents: false }, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledWith(false);
      applySettings({}, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledTimes(1);
    });

    it("applies scopeModels: false", () => {
      applySettings({ scopeModels: false }, appliers);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(false);
    });

    it("applies toolDescriptionMode", () => {
      applySettings({ toolDescriptionMode: "full" }, appliers);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("full");
    });

    it("applies outputTranscript (both true and false)", () => {
      applySettings({ outputTranscript: false }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(false);
      applySettings({ outputTranscript: true }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(true);
    });

    it("applies worktreeIsolation (both true and false)", () => {
      applySettings({ worktreeIsolation: false }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(false);
      applySettings({ worktreeIsolation: true }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(true);
    });

    it("applies defaultMaxTurns: 0 as the explicit unlimited marker", () => {
      applySettings({ defaultMaxTurns: 0 }, appliers);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(0);
    });

    it("calls setBackgroundByDefault with either boolean", () => {
      applySettings({ backgroundByDefault: false }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(false);
      applySettings({ backgroundByDefault: true }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(true);
    });

    it("does not call setBackgroundByDefault when the field is absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setBackgroundByDefault).not.toHaveBeenCalled();
    });

  });

  describe("persistToastFor", () => {
    it("returns info-level toast with the plain message on success", () => {
      expect(persistToastFor("Max concurrency set to 7", true)).toEqual({
        message: "Max concurrency set to 7",
        level: "info",
      });
    });

    it("returns warning-level toast with session-only suffix on failure", () => {
      expect(persistToastFor("Max concurrency set to 7", false)).toEqual({
        message: "Max concurrency set to 7 (session only; failed to persist)",
        level: "warning",
      });
    });
  });

  describe("applyAndEmitLoaded", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setMaxConcurrentForeground: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
      setRememberAgents: vi.fn(),
        setWidgetMode: vi.fn(),
        setViewerMarkdown: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
        setShowModel: vi.fn(),
      };
    });

    it("loads, applies, and emits subagents:settings_loaded with merged settings", () => {
      writeGlobal({ maxConcurrent: 16 });
      writeProject({ graceTurns: 7 });
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", {
        settings: { maxConcurrent: 16, graceTurns: 7 },
        policy: NO_POLICY,
      });
      expect(result).toEqual({ maxConcurrent: 16, graceTurns: 7 });
    });

    it("still emits the event when both files are missing (payload carries {})", () => {
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: {}, policy: NO_POLICY });
      expect(result).toEqual({});
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
    });
  });

  describe("saveAndEmitChanged", () => {
    const change = (layer: "global" | "project", key: string, value: unknown) =>
      ({ layer, key, value }) as Parameters<typeof saveAndEmitChanged>[0];

    it("persists one key, applies the effective settings, emits, and returns an info toast", () => {
      const emit = vi.fn();
      const appliers = spyAppliers();
      writeProject({ graceTurns: 2 });

      const toast = saveAndEmitChanged(
        change("project", "maxConcurrent", 5),
        "Max concurrency set to 5",
        emit,
        appliers,
        projectDir,
      );

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
        settings: { ...effectiveSettings(projectDir), maxConcurrent: 5, graceTurns: 2 },
        persisted: true,
        layer: "project",
        policy: NO_POLICY,
      });
      expect(toast).toEqual({ message: "Max concurrency set to 5", level: "info" });
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ graceTurns: 2, maxConcurrent: 5 });
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(5);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(2);
    });

    it("keeps a global edit live after a different key saves to the project", () => {
      writeGlobal({ maxConcurrent: 16 });
      saveAndEmitChanged(change("project", "graceTurns", 3), "ok", vi.fn(), spyAppliers(), projectDir);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ graceTurns: 3 });

      writeGlobal({ maxConcurrent: 32 });
      const appliers = spyAppliers();
      saveAndEmitChanged(change("project", "showCost", true), "ok", vi.fn(), appliers, projectDir);
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(32);
    });

    it("writes the global file for a global change and leaves the project file alone", () => {
      writeProject({ maxConcurrent: 2 });
      const emit = vi.fn();
      const appliers = spyAppliers();
      saveAndEmitChanged(change("global", "graceTurns", 9), "ok", emit, appliers, projectDir);
      expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ graceTurns: 9 });
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(2);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(9);
    });

    it("keeps unknown keys and the policy in the file", () => {
      const policy = { tools: { deny: ["bash"] }, ephemeralNesting: false };
      writeProject({ maxConcurrent: 3, policy, futureKey: { a: 1 } });
      saveAndEmitChanged(change("project", "maxConcurrent", 7), "ok", vi.fn(), spyAppliers(), projectDir);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 7, policy, futureKey: { a: 1 } });
    });

    it("does not write a layer file that fails to parse, and warns naming it", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeFileSync(globalFile(), "{ broken");
        const emit = vi.fn();
        const toast = saveAndEmitChanged(change("global", "graceTurns", 4), "ok", emit, spyAppliers(), projectDir);
        expect(readFileSync(globalFile(), "utf-8")).toBe("{ broken");
        expect(spy).toHaveBeenCalledWith(expect.stringContaining(globalFile()));
        expect(toast.level).toBe("warning");
        expect(emit).toHaveBeenCalledWith(
          "subagents:settings_changed",
          expect.objectContaining({ persisted: false }),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("removes the key on a reset and applies the inherited value live", () => {
      writeGlobal({ graceTurns: 9 });
      writeProject({ graceTurns: 2, showCost: true });
      const appliers = spyAppliers();
      const emit = vi.fn();
      saveAndEmitChanged(change("project", "graceTurns", undefined), "ok", emit, appliers, projectDir);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ showCost: true });
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(9);
      expect(emit).toHaveBeenCalledWith(
        "subagents:settings_changed",
        expect.objectContaining({ persisted: true, settings: expect.objectContaining({ graceTurns: 9 }) }),
      );
    });

    it("names the global layer and carries the effective settings of both files and the defaults", () => {
      writeProject({ maxConcurrent: 2 });
      const emit = vi.fn();
      saveAndEmitChanged(change("global", "graceTurns", 9), "ok", emit, spyAppliers(), projectDir);
      const payload = emit.mock.calls[0][1];
      expect(emit.mock.calls[0][0]).toBe("subagents:settings_changed");
      expect(payload.layer).toBe("global");
      expect(payload.settings).toEqual({ ...effectiveSettings(projectDir), maxConcurrent: 2, graceTurns: 9 });
      expect(Object.keys(payload.settings).sort()).toEqual([...SETTING_KEYS].sort());
    });

    it("returns a global reset to the default live", () => {
      writeGlobal({ graceTurns: 9, futureKey: true });
      const appliers = spyAppliers();
      saveAndEmitChanged(change("global", "graceTurns", undefined), "ok", vi.fn(), appliers, projectDir);
      expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ futureKey: true });
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(SETTING_SPECS.graceTurns.default);
    });

    it("does not trim a project file that holds a full snapshot", () => {
      const snapshot = { maxConcurrent: 10, graceTurns: 5, showCost: false, widgetMode: "all" };
      writeProject(snapshot);
      saveAndEmitChanged(change("project", "showCost", true), "ok", vi.fn(), spyAppliers(), projectDir);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ ...snapshot, showCost: true });
    });

    it("emits with persisted=false and returns warning toast on save failure", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      const emit = vi.fn();
      try {
        const toast = saveAndEmitChanged(
          change("project", "maxConcurrent", 5),
          "Max concurrency set to 5",
          emit,
          spyAppliers(),
          filePosingAsCwd,
        );
        expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
          settings: { ...effectiveSettings(projectDir), maxConcurrent: 5 },
          persisted: false,
          layer: "project",
          policy: NO_POLICY,
        });
        expect(toast).toEqual({
          message: "Max concurrency set to 5 (session only; failed to persist)",
          level: "warning",
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });
  });

  describe("defaults and bounds table", () => {
    it("has an entry for every setting the appliers handle", () => {
      const called = new Set<string>();
      const appliers = new Proxy({}, { get: (_t, name) => () => called.add(String(name)) }) as SettingsAppliers;
      const everything = Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTING_SPECS[key].default]));
      applySettings(everything, appliers);
      expect(called.size).toBe(SETTING_KEYS.length);
    });

    it("returns every default when no file sets a key", () => {
      const effective = effectiveSettings(projectDir);
      for (const key of SETTING_KEYS) expect(effective[key]).toBe(SETTING_SPECS[key].default);
    });

    it("lets a file override a default", () => {
      writeGlobal({ maxConcurrent: 16 });
      writeProject({ graceTurns: 2 });
      expect(effectiveSettings(projectDir)).toMatchObject({ maxConcurrent: 16, graceTurns: 2, widgetMode: "all" });
    });

    const integerKeys = SETTING_KEYS.filter((key) => SETTING_SPECS[key].kind === "integer");
    const enumKeys = SETTING_KEYS.filter((key) => SETTING_SPECS[key].kind === "enum");
    const booleanKeys = SETTING_KEYS.filter((key) => SETTING_SPECS[key].kind === "boolean");
    const specOf = (key: (typeof SETTING_KEYS)[number]) => SETTING_SPECS[key] as SettingSpec;
    const loaded = (key: string, value: unknown) => {
      writeProject({ [key]: value });
      return (loadSettings(projectDir) as Record<string, unknown>)[key];
    };

    it.each(integerKeys)("%s keeps its bounds and drops anything outside", (key) => {
      const spec = specOf(key) as Extract<SettingSpec, { kind: "integer" }>;
      expect(loaded(key, spec.min)).toBe(spec.min);
      expect(loaded(key, spec.max)).toBe(spec.max);
      expect(loaded(key, spec.min - 1)).toBeUndefined();
      expect(loaded(key, spec.max + 1)).toBeUndefined();
      expect(loaded(key, spec.min + 0.5)).toBeUndefined();
      expect(loaded(key, String(spec.min))).toBeUndefined();
    });

    it.each(enumKeys)("%s keeps its values and drops others", (key) => {
      const spec = specOf(key) as Extract<SettingSpec, { kind: "enum" }>;
      for (const value of spec.values) expect(loaded(key, value)).toBe(value);
      expect(loaded(key, "nope")).toBeUndefined();
      expect(loaded(key, 1)).toBeUndefined();
    });

    it.each(booleanKeys)("%s keeps booleans and drops other types", (key) => {
      expect(loaded(key, true)).toBe(true);
      expect(loaded(key, false)).toBe(false);
      expect(loaded(key, "true")).toBeUndefined();
    });

    it("drops one bad value without affecting the other keys", () => {
      writeProject({ maxConcurrent: 5000, graceTurns: 3 });
      expect(loadSettings(projectDir)).toEqual({ graceTurns: 3 });
    });
  });
});
