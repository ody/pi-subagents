import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsPersistence } from "../src/config/runtime-settings.js";
import type { SettingsAppliers } from "../src/config/settings.js";
import { SETTING_KEYS, SETTING_SPECS } from "../src/config/settings-defaults.js";
import { applySettingValue, initialLayer, resetSettingValue, type SettingsMenuDeps, showSettings } from "../src/ui/settings-menu.js";
import { SETTING_ROWS } from "../src/ui/settings-rows.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "> ",
    hint: (text: string) => text,
  }),
}));

const notifyApplied = vi.fn();
const notify = vi.fn();

let globalDir: string;
let projectDir: string;
let originalAgentDirEnv: string | undefined;

const globalFile = () => join(globalDir, "subagents.json");
const projectFile = () => join(projectDir, ".pi", "subagents.json");
const writeGlobal = (obj: unknown) => writeFileSync(globalFile(), typeof obj === "string" ? obj : JSON.stringify(obj));
const writeProject = (obj: unknown) => {
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(projectFile(), typeof obj === "string" ? obj : JSON.stringify(obj));
};
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), "pi-menu-global-"));
  projectDir = mkdtempSync(join(tmpdir(), "pi-menu-project-"));
  originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalDir;
});

afterEach(() => {
  if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
const mockDeps = (): SettingsMenuDeps => ({ cwd: projectDir, settingsPersist: { notifyApplied } });

function apply(id: string, value: string, layer: "global" | "project" = "project") {
  applySettingValue(ctx, mockDeps(), layer, id, value);
}

function lastCall(): { message: string; change: unknown } {
  expect(notifyApplied).toHaveBeenCalledTimes(1);
  expect(notifyApplied.mock.calls[0][0]).toBe(ctx);
  return { message: notifyApplied.mock.calls[0][1], change: notifyApplied.mock.calls[0][2] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applySettingValue numeric settings", () => {
  it.each([
    ["maxConcurrent", "4", 4, "Max concurrency set to 4"],
    ["maxConcurrentForeground", "3", 3, "Max foreground concurrency set to 3"],
    ["maxConcurrentForeground", "0", 0, "Max foreground concurrency set to unlimited"],
    ["defaultMaxTurns", "12", 12, "Default max turns set to 12"],
    ["defaultMaxTurns", "0", 0, "Default max turns set to unlimited"],
    ["graceTurns", "7", 7, "Grace turns set to 7"],
    ["maxSubagentDepth", "3", 3, "Nested depth set to 3. Applies to agents started from now on."],
    ["maxSubagentDepth", "0", 0, "Nested delegation disabled"],
    ["maxSubagentDepth", "1", 1, "Nested delegation disabled"],
  ])("%s %s", (id, input, value, message) => {
    apply(id, input);
    expect(lastCall()).toEqual({ message, change: { layer: "project", key: id, value } });
  });

  it.each([
    ["maxConcurrent", "0", "1 to 1024"],
    ["maxConcurrent", "-1", "1 to 1024"],
    ["maxConcurrent", "1025", "1 to 1024"],
    ["maxConcurrentForeground", "-1", "0 to 1024"],
    ["defaultMaxTurns", "-3", "0 to 10000"],
    ["defaultMaxTurns", "10001", "0 to 10000"],
    ["graceTurns", "0", "1 to 1000"],
    ["graceTurns", "-2", "1 to 1000"],
    ["maxSubagentDepth", "-1", "0 to 16"],
    ["maxSubagentDepth", "17", "0 to 16"],
    ["maxConcurrent", "abc", "1 to 1024"],
    ["maxConcurrent", "", "1 to 1024"],
  ])("rejects %s %j and names the range", (id, value, range) => {
    apply(id, value);
    expect(notifyApplied).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(`${id} must be a whole number from ${range}`, "warning");
  });
});

describe("applySettingValue enum and toggle settings", () => {
  it.each([
    ["defaultJoinMode", "smart", "defaultJoinMode", "smart", "Default join mode set to smart"],
    ["backgroundByDefault", "on", "backgroundByDefault", true, "agent calls run in the background unless they pass run_in_background: false"],
    ["backgroundByDefault", "off", "backgroundByDefault", false, "agent calls block and return inline unless they pass run_in_background: true"],
    ["scopeModels", "on", "scopeModels", true, "Scope models enabled"],
    ["scopeModels", "off", "scopeModels", false, "Scope models disabled"],
    ["strictAgentFiles", "on", "strictAgentFiles", true, "Strict agent files enabled. Takes effect on next pi session."],
    ["strictAgentFiles", "off", "strictAgentFiles", false, "Strict agent files disabled. Takes effect on next pi session."],
    ["outputTranscript", "on", "outputTranscript", true, "Output transcript enabled by default"],
    ["outputTranscript", "off", "outputTranscript", false, "Output transcript disabled by default"],
    ["worktreeIsolation", "on", "worktreeIsolation", true, "Worktree isolation enabled. Tool parameter updates on next pi session."],
    ["worktreeIsolation", "off", "worktreeIsolation", false, "Worktree isolation disabled. Tool parameter updates on next pi session."],
    ["toolDescriptionMode", "compact", "toolDescriptionMode", "compact", "Tool description set to compact. Takes effect on next pi session."],
    ["reportUsage", "on", "reportUsage", true, "Subagent usage now counted in this session's totals"],
    ["reportUsage", "off", "reportUsage", false, "Subagent usage no longer counted in this session's totals"],
    ["showCost", "on", "showCost", true, "Cost display enabled"],
    ["showCost", "off", "showCost", false, "Cost display disabled"],
    ["showModel", "on", "showModel", true, "Model display enabled"],
    ["showModel", "off", "showModel", false, "Model display disabled"],
    ["viewerMarkdown", "assistant", "viewerMarkdown", "assistant", "Viewer markdown set to assistant"],
    ["fleetView", "on", "fleetView", true, "Fleet view enabled"],
    ["fleetView", "off", "fleetView", false, "Fleet view disabled"],
    ["agentMentions", "off", "agentMentions", "off", "Agent mentions disabled"],
    ["agentMentions", "model", "agentMentions", "model", "Agent mentions on — a conversation clone starts a mentioned agent off-screen"],
    ["agentMentions", "direct", "agentMentions", "direct", "Agent mentions on — a mentioned agent starts here, with no model call"],
    ["rememberAgents", "on", "rememberAgents", true, "Remember agents enabled"],
    ["rememberAgents", "off", "rememberAgents", false, "Remember agents disabled"],
    ["widgetMode", "background", "widgetMode", "background", "Widget set to background"],
  ])("%s %s", (id, input, key, value, message) => {
    apply(id, input);
    expect(lastCall()).toEqual({ message, change: { layer: "project", key, value } });
  });

  it("unknown id is a silent no-op", () => {
    apply("nope", "on");
    expect(notifyApplied).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("showSettings numeric prompt", () => {
  const custom = vi.fn();
  const input = vi.fn();
  const promptCtx = { ui: { notify, custom, input } } as unknown as ExtensionCommandContext;

  let deps: SettingsMenuDeps;

  beforeEach(() => {
    deps = mockDeps();
    writeGlobal({ maxConcurrent: 4, maxConcurrentForeground: 2 });
  });

  it.each([
    ["maxConcurrent", "Max concurrency (1 to 1024)", "4"],
    ["maxConcurrentForeground", "Max foreground concurrency, 0 = unlimited (0 to 1024)", "2"],
  ])("%s prompts with its label and current value", async (id, label, current) => {
    custom.mockResolvedValueOnce(id);
    input.mockResolvedValueOnce(undefined);
    await showSettings(promptCtx, deps);
    expect(input).toHaveBeenCalledWith(label, current);
  });

  it("re-prompts on non-numeric input with the last entry", async () => {
    custom.mockResolvedValueOnce("graceTurns");
    input.mockResolvedValueOnce("abc").mockResolvedValueOnce(undefined);
    await showSettings(promptCtx, deps);
    expect(input).toHaveBeenCalledTimes(2);
    expect(input).toHaveBeenNthCalledWith(2, "Grace turns (1 to 1000)", "abc");
    expect(notify).toHaveBeenCalledWith("graceTurns must be a whole number from 1 to 1000", "warning");
    expect(notifyApplied).not.toHaveBeenCalled();
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("applies a trimmed value, then reopens the menu", async () => {
    custom.mockResolvedValueOnce("graceTurns").mockResolvedValueOnce(undefined);
    input.mockResolvedValueOnce(" 7 ");
    await showSettings(promptCtx, deps);
    expect(notifyApplied).toHaveBeenCalledWith(promptCtx, "Grace turns set to 7", {
      layer: "global",
      key: "graceTurns",
      value: 7,
    });
    expect(custom).toHaveBeenCalledTimes(2);
    expect(notifyApplied.mock.invocationCallOrder[0]).toBeLessThan(custom.mock.invocationCallOrder[1]);
  });

  it("does not reopen or apply on cancel", async () => {
    custom.mockResolvedValueOnce("maxConcurrent");
    input.mockResolvedValueOnce(undefined);
    await showSettings(promptCtx, deps);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(notifyApplied).not.toHaveBeenCalled();
  });

  it("does not prompt when the menu closes or returns a non-numeric id", async () => {
    custom.mockResolvedValueOnce(undefined);
    await showSettings(promptCtx, deps);
    custom.mockResolvedValueOnce("defaultJoinMode");
    await showSettings(promptCtx, deps);
    expect(input).not.toHaveBeenCalled();
  });
});

describe("settings layers", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  type Menu = { render: (w: number) => string[]; handleInput: (data: string) => void };
  let menus: Menu[];
  let custom: ReturnType<typeof vi.fn>;
  let input: ReturnType<typeof vi.fn>;
  let layerCtx: ExtensionCommandContext;
  const appliers = new Proxy({}, { get: () => vi.fn() }) as SettingsAppliers;
  const emit = vi.fn();

  const realDeps = (): SettingsMenuDeps => ({
    cwd: projectDir,
    settingsPersist: createSettingsPersistence(appliers, emit, projectDir),
  });

  const open = (deps: SettingsMenuDeps, state?: Parameters<typeof showSettings>[2]) => {
    const shown = showSettings(layerCtx, deps, state);
    return { shown, menu: () => menus[menus.length - 1] };
  };

  beforeEach(() => {
    menus = [];
    input = vi.fn();
    custom = vi.fn(
      (factory: (...args: unknown[]) => Menu) =>
        new Promise((resolve) => {
          menus.push(factory({}, theme, {}, resolve));
        }),
    );
    layerCtx = { ui: { notify, custom, input } } as unknown as ExtensionCommandContext;
  });

  it("opens on the global layer when the project file is missing", () => {
    expect(initialLayer(projectDir)).toBe("global");
    const { menu } = open(realDeps());
    expect(menu().render(100).join("\n")).toContain("Scope: global | project");
  });

  it("opens on the project layer when the project file exists", () => {
    writeProject({});
    expect(initialLayer(projectDir)).toBe("project");
    expect(existsSync(projectFile())).toBe(true);
  });

  it("marks the layer in the header and advertises tab scope in the footer", () => {
    const { menu } = open(realDeps());
    const lines = menu().render(100);
    expect(lines[1]).toContain("Scope: global | project");
    expect(lines[lines.length - 1]).toContain("tab scope");
  });

  it("tab switches layers at any time and keeps the selected row", async () => {
    writeGlobal({ maxConcurrent: 3 });
    writeProject({ maxConcurrent: 8 });
    const { shown, menu } = open(realDeps(), { layer: "global" });
    expect(menu().render(100).join("\n")).toContain("3");
    menu().handleInput("\x1b[B");
    menu().handleInput("\t");
    await vi.waitFor(() => expect(menus).toHaveLength(2));
    const rendered = menu().render(100).join("\n");
    expect(rendered).toMatch(/Max concurrency[^\n]*\s8\n/);
    menu().handleInput("\t");
    await vi.waitFor(() => expect(menus).toHaveLength(3));
    expect(menu().render(100).join("\n")).toMatch(/Max concurrency\s+3/);
    menu().handleInput("\x1b");
    await shown;
  });

  it("shows the default for an unset key on the global layer and the effective value on the project layer", () => {
    writeGlobal({ graceTurns: 9 });
    writeProject({ maxConcurrent: 2 });
    const global = open(realDeps(), { layer: "global" }).menu().render(100).join("\n");
    expect(global).toMatch(/Max concurrency\s+10/);
    const project = open(realDeps(), { layer: "project" }).menu().render(100).join("\n");
    expect(project).toMatch(/Max concurrency[^\n]*\s2\n/);
    expect(project).toMatch(/Grace turns[^\n]*\s9\n/);
  });

  it("writes the global file from the global layer and tells the user when the project overrides the key", () => {
    writeProject({ maxConcurrent: 2 });
    writeGlobal({});
    applySettingValue(layerCtx, realDeps(), "global", "maxConcurrent", "6");
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 6 });
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 2 });
    expect(notify).toHaveBeenCalledWith(
      "Max concurrency set to 6. This project overrides it, so the change does not reach this project.",
      "info",
    );
    notify.mockClear();
    applySettingValue(layerCtx, realDeps(), "global", "graceTurns", "6");
    expect(notify).toHaveBeenCalledWith("Grace turns set to 6", "info");
  });

  it("writes only the changed key to the project file from the project layer", () => {
    writeGlobal({ maxConcurrent: 16 });
    writeProject({});
    applySettingValue(layerCtx, realDeps(), "project", "graceTurns", "4");
    expect(readJson(projectFile())).toEqual({ graceTurns: 4 });
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 16 });
  });

  it("shows a parse error and stays read-only on a layer file that does not parse", () => {
    writeProject("{ broken");
    const { menu } = open(realDeps(), { layer: "project" });
    expect(menu().render(200).join("\n")).toContain(`${projectFile()} cannot be parsed`);
    menu().handleInput("\r");
    menu().handleInput(" ");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Fix the file first"), "warning");
    expect(readFileSync(projectFile(), "utf-8")).toBe("{ broken");
    expect(input).not.toHaveBeenCalled();
  });

  it("does not open the numeric prompt on a read-only layer", () => {
    writeGlobal("{ broken");
    const { menu } = open(realDeps(), { layer: "global" });
    menu().handleInput("\r");
    expect(input).not.toHaveBeenCalled();
  });

  it("marks project, overriding, and inherited rows on the project layer only", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 9 });
    writeProject({ graceTurns: 2, showCost: true });
    const project = open(realDeps(), { layer: "project" }).menu().render(200);
    const row = (text: string) => project.find((line) => line.includes(text)) ?? "";
    expect(row("Grace turns")).toContain("Grace turns (overrides global)");
    expect(row("Show cost")).toContain("Show cost (project)");
    expect(row("Max concurrency")).toContain("Max concurrency (inherited)");
    const global = open(realDeps(), { layer: "global" }).menu().render(200).join("\n");
    expect(global).not.toMatch(/\((project|inherited|overrides global)\)/);
  });

  it("dims an inherited row", () => {
    const dimTheme = { fg: (_color: string, text: string) => `<dim>${text}</dim>`, bold: (text: string) => text };
    custom.mockImplementationOnce(
      (factory: (...args: unknown[]) => Menu) =>
        new Promise((resolve) => {
          menus.push(factory({}, dimTheme, {}, resolve));
        }),
    );
    writeProject({ graceTurns: 2 });
    open(realDeps(), { layer: "project" });
    const lines = menus[0].render(200);
    expect(lines.find((line) => line.includes("Max concurrency"))).toContain("<dim>Max concurrency (inherited)</dim>");
    expect(lines.find((line) => line.includes("Grace turns"))).not.toContain("<dim>Grace turns");
  });

  it("turns a key into a project override when it changes on the project layer", async () => {
    writeGlobal({ showCost: false });
    writeProject({ graceTurns: 2 });
    const { menu } = open(realDeps(), { layer: "project", selected: "showCost" });
    expect(menu().render(200).find((line) => line.includes("Show cost"))).toContain("(inherited)");
    menu().handleInput(" ");
    await vi.waitFor(() => expect(menus).toHaveLength(2));
    expect(readJson(projectFile())).toEqual({ graceTurns: 2, showCost: true });
    expect(readJson(globalFile())).toEqual({ showCost: false });
    expect(menu().render(200).find((line) => line.includes("Show cost"))).toContain("Show cost (overrides global)");
  });

  it("advertises r reset in the footer", () => {
    const lines = open(realDeps()).menu().render(100);
    expect(lines[lines.length - 1]).toContain("r reset");
  });

  it("r removes the key from the project file so the row inherits, and the session takes the inherited value", async () => {
    writeGlobal({ graceTurns: 9 });
    writeProject({ graceTurns: 2, showCost: true });
    const applied: number[] = [];
    const tracking = new Proxy({}, {
      get: (_t, name) => (n: unknown) => {
        if (name === "setGraceTurns") applied.push(n as number);
      },
    }) as SettingsAppliers;
    const deps: SettingsMenuDeps = { cwd: projectDir, settingsPersist: createSettingsPersistence(tracking, emit, projectDir) };
    const { menu } = open(deps, { layer: "project", selected: "graceTurns" });
    menu().handleInput("r");
    await vi.waitFor(() => expect(menus).toHaveLength(2));
    expect(readJson(projectFile())).toEqual({ showCost: true });
    expect(applied).toEqual([9]);
    expect(menu().render(200).find((line) => line.includes("Grace turns"))).toContain("Grace turns (inherited)");
    expect(notify).toHaveBeenCalledWith("Grace turns now inherits", "info");
  });

  it("r on a global row returns it to the default and tells the user when the project overrides it", () => {
    writeGlobal({ graceTurns: 9, showCost: true, futureKey: 1 });
    writeProject({ graceTurns: 2 });
    expect(resetSettingValue(layerCtx, realDeps(), "global", "graceTurns")).toBe(true);
    expect(readJson(globalFile())).toEqual({ showCost: true, futureKey: 1 });
    expect(notify).toHaveBeenCalledWith(
      "Grace turns is back to the default. This project overrides it, so the change does not reach this project.",
      "info",
    );
  });

  it("r on a row the layer does not set does nothing", async () => {
    writeGlobal({ graceTurns: 9 });
    writeProject({ showCost: true });
    const before = readFileSync(projectFile(), "utf-8");
    const { menu } = open(realDeps(), { layer: "project", selected: "graceTurns" });
    menu().handleInput("r");
    expect(menus).toHaveLength(1);
    expect(readFileSync(projectFile(), "utf-8")).toBe(before);
    expect(notify).not.toHaveBeenCalled();
    expect(resetSettingValue(layerCtx, realDeps(), "project", "graceTurns")).toBe(false);
  });

  it("r removes keys of a full snapshot one at a time", () => {
    const snapshot = { maxConcurrent: 10, graceTurns: 5, showCost: false };
    writeProject(snapshot);
    resetSettingValue(layerCtx, realDeps(), "project", "graceTurns");
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 10, showCost: false });
  });

  it("keeps a full-snapshot project file across tab switches and r removes its keys one at a time", async () => {
    const snapshot = Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTING_SPECS[key].default]));
    writeGlobal({});
    writeProject(snapshot);
    const { shown, menu } = open(realDeps(), { layer: "global", selected: "graceTurns" });
    menu().handleInput("\t");
    await vi.waitFor(() => expect(menus).toHaveLength(2));
    menu().handleInput("\t");
    await vi.waitFor(() => expect(menus).toHaveLength(3));
    menu().handleInput("\t");
    await vi.waitFor(() => expect(menus).toHaveLength(4));
    expect(readJson(projectFile())).toEqual(snapshot);
    menu().handleInput("r");
    await vi.waitFor(() => expect(menus).toHaveLength(5));
    const { graceTurns: _grace, ...withoutGrace } = snapshot;
    expect(readJson(projectFile())).toEqual(withoutGrace);
    menu().handleInput("\x1b[B");
    menu().handleInput("r");
    await vi.waitFor(() => expect(menus).toHaveLength(6));
    const { maxSubagentDepth: _depth, ...rest } = withoutGrace;
    expect(readJson(projectFile())).toEqual(rest);
    menu().handleInput("\x1b");
    await shown;
  });

  it("r does nothing on a read-only layer", () => {
    writeProject("{ broken");
    const { menu } = open(realDeps(), { layer: "project" });
    menu().handleInput("r");
    expect(readFileSync(projectFile(), "utf-8")).toBe("{ broken");
    expect(menus).toHaveLength(1);
  });

  describe("Ephemeral nesting row", () => {
    const row = (lines: string[]) => lines.find((line) => line.includes("Ephemeral nesting")) ?? "";
    const apply = (id: string, value: string, layer: "global" | "project") =>
      applySettingValue(layerCtx, realDeps(), layer, id, value);

    it("appears in both layers and shows the effective value", () => {
      writeGlobal({ policy: { ephemeralNesting: false } });
      writeProject({});
      expect(row(open(realDeps(), { layer: "global" }).menu().render(200))).toMatch(/off\s*$/);
      expect(row(open(realDeps(), { layer: "project" }).menu().render(200))).toMatch(/\(inherited\)\s+off\s*$/);
    });

    it("defaults to on in both layers", () => {
      expect(row(open(realDeps(), { layer: "global" }).menu().render(200))).toMatch(/on\s*$/);
      expect(row(open(realDeps(), { layer: "project" }).menu().render(200))).toMatch(/on\s*$/);
    });

    it("writes policy.ephemeralNesting only and keeps the rest of policy", () => {
      const policy = { tools: { deny: ["bash"] }, ephemeralNesting: true };
      writeGlobal({ maxConcurrent: 3, policy, futureKey: 1 });
      apply("ephemeralNesting", "off", "global");
      expect(readJson(globalFile())).toEqual({
        maxConcurrent: 3,
        policy: { tools: { deny: ["bash"] }, ephemeralNesting: false },
        futureKey: 1,
      });
    });

    it("fires settings_changed with the policy payload and the layer", () => {
      writeGlobal({});
      const events: Array<[string, any]> = [];
      const deps: SettingsMenuDeps = {
        cwd: projectDir,
        settingsPersist: createSettingsPersistence(appliers, (event, payload) => events.push([event, payload]), projectDir),
      };
      applySettingValue(layerCtx, deps, "project", "ephemeralNesting", "off");
      expect(readJson(projectFile())).toEqual({ policy: { ephemeralNesting: false } });
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe("subagents:settings_changed");
      expect(events[0][1]).toMatchObject({
        layer: "project",
        persisted: true,
        policy: { global: {}, project: {}, ephemeralNesting: false },
      });
    });

    it("refuses to turn on in the project while the global file has it off", () => {
      writeGlobal({ policy: { ephemeralNesting: false } });
      writeProject({ policy: { ephemeralNesting: false } });
      apply("ephemeralNesting", "on", "project");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("off in the global file"), "warning");
      expect(readJson(projectFile())).toEqual({ policy: { ephemeralNesting: false } });
    });

    it("lets the project turn it off, and on again when the global file allows it", () => {
      writeGlobal({});
      apply("ephemeralNesting", "off", "project");
      apply("ephemeralNesting", "on", "project");
      expect(readJson(projectFile())).toEqual({ policy: { ephemeralNesting: true } });
    });

    it("warns when a global change does not reach a project that turned it off", () => {
      writeProject({ policy: { ephemeralNesting: false } });
      apply("ephemeralNesting", "on", "global");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("does not reach this project"), "info");
    });

    it("refuses to write when policy is not an object", () => {
      writeGlobal({ policy: "nope" });
      apply("ephemeralNesting", "off", "global");
      expect(readJson(globalFile())).toEqual({ policy: "nope" });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("failed to persist"), "warning");
    });

    it("r removes the key and an emptied policy", () => {
      writeProject({ maxConcurrent: 2, policy: { ephemeralNesting: false } });
      expect(resetSettingValue(layerCtx, realDeps(), "project", "ephemeralNesting")).toBe(true);
      expect(readJson(projectFile())).toEqual({ maxConcurrent: 2 });
      writeProject({ policy: { tools: { deny: ["bash"] }, ephemeralNesting: false } });
      resetSettingValue(layerCtx, realDeps(), "project", "ephemeralNesting");
      expect(readJson(projectFile())).toEqual({ policy: { tools: { deny: ["bash"] } } });
      expect(resetSettingValue(layerCtx, realDeps(), "project", "ephemeralNesting")).toBe(false);
    });
  });

  it("keeps a later global edit live after a project change on another key", () => {
    const calls: number[] = [];
    const tracking = new Proxy({}, {
      get: (_t, name) => (n: unknown) => {
        if (name === "setMaxConcurrent") calls.push(n as number);
      },
    }) as SettingsAppliers;
    const deps: SettingsMenuDeps = { cwd: projectDir, settingsPersist: createSettingsPersistence(tracking, emit, projectDir) };
    writeGlobal({ maxConcurrent: 16 });
    applySettingValue(layerCtx, deps, "project", "graceTurns", "4");
    expect(readJson(projectFile())).toEqual({ graceTurns: 4 });
    applySettingValue(layerCtx, deps, "global", "maxConcurrent", "32");
    expect(calls[calls.length - 1]).toBe(32);
  });
});

describe("settings rows match the setting specs", () => {
  it.each(SETTING_KEYS)("%s row lists the values its spec allows", (key) => {
    const spec = SETTING_SPECS[key];
    const row = SETTING_ROWS.find((candidate) => candidate.id === key);
    expect(row).toBeDefined();
    if (spec.kind === "integer") expect(row?.values).toBeUndefined();
    else if (spec.kind === "boolean") expect([...(row?.values ?? [])].sort()).toEqual(["off", "on"]);
    else expect([...(row?.values ?? [])].sort()).toEqual([...spec.values].sort());
  });

  it("has no row outside the specs except ephemeralNesting", () => {
    const extra = SETTING_ROWS.map((row) => row.id).filter((id) => !(SETTING_KEYS as string[]).includes(id));
    expect(extra).toEqual(["ephemeralNesting"]);
  });
});
