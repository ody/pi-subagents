import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFallbackSubagent, NO_FALLBACK, setFallbackSubagent } from "../src/agent-types.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../src/nested-tools.js";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../src/output-file.js";
import { getDefaultMaxTurns, getGraceTurns, getRememberAgents, setDefaultMaxTurns, setGraceTurns, setRememberAgents } from "../src/runner-defaults.js";
import { applySettingValue, type SettingsMenuDeps } from "../src/ui/settings-menu.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../src/worktree.js";

const saved = {
  fallback: getFallbackSubagent(),
  scope: isScopeModelsEnabled(),
  depth: getMaxSubagentDepth(),
  transcript: getOutputTranscriptDefault(),
  maxTurns: getDefaultMaxTurns(),
  grace: getGraceTurns(),
  remember: getRememberAgents(),
  worktree: isWorktreeIsolationEnabled(),
};

afterEach(() => {
  setFallbackSubagent(saved.fallback);
  setScopeModelsEnabled(saved.scope);
  setMaxSubagentDepth(saved.depth);
  setOutputTranscriptDefault(saved.transcript);
  setDefaultMaxTurns(saved.maxTurns);
  setGraceTurns(saved.grace);
  setRememberAgents(saved.remember);
  setWorktreeIsolationEnabled(saved.worktree);
});

const appliers = {
  setDefaultJoinMode: vi.fn(),
  setBackgroundByDefault: vi.fn(),
  setSchedulingEnabled: vi.fn(),
  setStrictAgentFiles: vi.fn(),
  setDisableDefaultAgents: vi.fn(),
  setToolDescriptionMode: vi.fn(),
  setFleetView: vi.fn(),
  setAgentMentions: vi.fn(),
  setWidgetMode: vi.fn(),
  setReportUsage: vi.fn(),
  setShowCost: vi.fn(),
  setShowModel: vi.fn(),
  setViewerMarkdown: vi.fn(),
};
const manager = {
  getMaxConcurrent: vi.fn(),
  getMaxConcurrentForeground: vi.fn(),
  setMaxConcurrent: vi.fn(),
  setMaxConcurrentForeground: vi.fn(),
};
const scheduler = { stop: vi.fn() };
const notifyApplied = vi.fn();
const notify = vi.fn();
let schedulingEnabled = false;

const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
const deps = {
  get settings() { return { schedulingEnabled } as SettingsMenuDeps["settings"]; },
  appliers,
  manager,
  scheduler,
  settingsPersist: { notifyApplied },
  isStrictAgentFiles: () => false,
} as SettingsMenuDeps;

function apply(id: string, value: string) {
  applySettingValue(ctx, deps, id, value);
}

function lastMessage(): string {
  expect(notifyApplied).toHaveBeenCalledTimes(1);
  expect(notifyApplied.mock.calls[0][0]).toBe(ctx);
  return notifyApplied.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  schedulingEnabled = false;
});

describe("applySettingValue numeric settings", () => {
  it("maxConcurrent", () => {
    apply("maxConcurrent", "4");
    expect(manager.setMaxConcurrent).toHaveBeenCalledWith(4);
    expect(lastMessage()).toBe("Max concurrency set to 4");
  });

  it("maxConcurrentForeground", () => {
    apply("maxConcurrentForeground", "3");
    expect(manager.setMaxConcurrentForeground).toHaveBeenCalledWith(3);
    expect(lastMessage()).toBe("Max foreground concurrency set to 3");
  });

  it("maxConcurrentForeground accepts 0 as unlimited", () => {
    apply("maxConcurrentForeground", "0");
    expect(manager.setMaxConcurrentForeground).toHaveBeenCalledWith(0);
    expect(lastMessage()).toBe("Max foreground concurrency set to unlimited");
  });

  it("defaultMaxTurns", () => {
    apply("defaultMaxTurns", "12");
    expect(getDefaultMaxTurns()).toBe(12);
    expect(lastMessage()).toBe("Default max turns set to 12");
  });

  it("defaultMaxTurns 0 means unlimited", () => {
    setDefaultMaxTurns(5);
    apply("defaultMaxTurns", "0");
    expect(getDefaultMaxTurns()).toBeUndefined();
    expect(lastMessage()).toBe("Default max turns set to unlimited");
  });

  it("graceTurns", () => {
    apply("graceTurns", "7");
    expect(getGraceTurns()).toBe(7);
    expect(lastMessage()).toBe("Grace turns set to 7");
  });

  it("maxSubagentDepth above 1", () => {
    apply("maxSubagentDepth", "3");
    expect(getMaxSubagentDepth()).toBe(3);
    expect(lastMessage()).toBe("Nested depth set to 3. Applies to agents started from now on.");
  });

  it("maxSubagentDepth 0 and 1 disable nesting", () => {
    apply("maxSubagentDepth", "0");
    expect(getMaxSubagentDepth()).toBe(0);
    expect(lastMessage()).toBe("Nested delegation disabled");
    vi.clearAllMocks();
    apply("maxSubagentDepth", "1");
    expect(getMaxSubagentDepth()).toBe(1);
    expect(lastMessage()).toBe("Nested delegation disabled");
  });

  it("rejects out-of-range and non-numeric values", () => {
    const depth = getMaxSubagentDepth();
    const grace = getGraceTurns();
    const turns = getDefaultMaxTurns();
    for (const [id, value] of [
      ["maxConcurrent", "0"],
      ["maxConcurrent", "-1"],
      ["maxConcurrentForeground", "-1"],
      ["defaultMaxTurns", "-3"],
      ["graceTurns", "0"],
      ["graceTurns", "-2"],
      ["maxSubagentDepth", "-1"],
      ["maxConcurrent", "abc"],
    ]) apply(id, value);
    expect(manager.setMaxConcurrent).not.toHaveBeenCalled();
    expect(manager.setMaxConcurrentForeground).not.toHaveBeenCalled();
    expect(getMaxSubagentDepth()).toBe(depth);
    expect(getGraceTurns()).toBe(grace);
    expect(getDefaultMaxTurns()).toBe(turns);
    expect(notifyApplied).not.toHaveBeenCalled();
  });
});

describe("applySettingValue enum and toggle settings", () => {
  it("joinMode", () => {
    apply("joinMode", "smart");
    expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("smart");
    expect(lastMessage()).toBe("Default join mode set to smart");
  });

  it.each([
    ["on", "Agent calls run in the background unless they pass run_in_background: false"],
    ["off", "Agent calls block and return inline unless they pass run_in_background: true"],
  ])("backgroundByDefault %s", (value, message) => {
    apply("backgroundByDefault", value);
    expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(value === "on");
    expect(lastMessage()).toBe(message);
  });

  it("schedulingEnabled on", () => {
    apply("schedulingEnabled", "on");
    expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(true);
    expect(scheduler.stop).not.toHaveBeenCalled();
    expect(lastMessage()).toBe("Scheduling enabled. Tool spec change takes effect on next pi session.");
  });

  it("schedulingEnabled off stops the scheduler", () => {
    schedulingEnabled = true;
    apply("schedulingEnabled", "off");
    expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(false);
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(lastMessage()).toBe("Scheduling disabled. Tool spec change takes effect on next pi session.");
  });

  it.each([
    [false, "off", "Scheduling already disabled."],
    [true, "on", "Scheduling already enabled."],
  ])("schedulingEnabled unchanged (%s -> %s) notifies via ui", (current, value, message) => {
    schedulingEnabled = current;
    apply("schedulingEnabled", value);
    expect(notify).toHaveBeenCalledWith(message, "info");
    expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
    expect(scheduler.stop).not.toHaveBeenCalled();
    expect(notifyApplied).not.toHaveBeenCalled();
  });

  it("scopeModels", () => {
    apply("scopeModels", "on");
    expect(isScopeModelsEnabled()).toBe(true);
    expect(lastMessage()).toBe("Scope models enabled");
    vi.clearAllMocks();
    apply("scopeModels", "off");
    expect(isScopeModelsEnabled()).toBe(false);
    expect(lastMessage()).toBe("Scope models disabled");
  });

  it("strictAgentFiles", () => {
    apply("strictAgentFiles", "on");
    expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Strict agent files enabled. Takes effect on next pi session.");
    vi.clearAllMocks();
    apply("strictAgentFiles", "off");
    expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Strict agent files disabled. Takes effect on next pi session.");
  });

  it("disableDefaultAgents", () => {
    apply("disableDefaultAgents", "on");
    expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Default agents disabled. Tool spec change takes effect on next pi session.");
    vi.clearAllMocks();
    apply("disableDefaultAgents", "off");
    expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Default agents enabled. Tool spec change takes effect on next pi session.");
  });

  it("fallbackSubagent with an agent type", () => {
    apply("fallbackSubagent", "Explore");
    expect(getFallbackSubagent()).toBe("Explore");
    expect(lastMessage()).toBe("Unknown agent types will fall back to Explore");
  });

  it("fallbackSubagent none", () => {
    apply("fallbackSubagent", NO_FALLBACK);
    expect(getFallbackSubagent()).toBe(NO_FALLBACK);
    expect(lastMessage()).toBe("Unknown or disabled agent types will now be rejected");
  });

  it("outputTranscript", () => {
    apply("outputTranscript", "on");
    expect(getOutputTranscriptDefault()).toBe(true);
    expect(lastMessage()).toBe("Output transcript enabled by default");
    vi.clearAllMocks();
    apply("outputTranscript", "off");
    expect(getOutputTranscriptDefault()).toBe(false);
    expect(lastMessage()).toBe("Output transcript disabled by default");
  });

  it("worktreeIsolation", () => {
    apply("worktreeIsolation", "on");
    expect(isWorktreeIsolationEnabled()).toBe(true);
    expect(lastMessage()).toBe("Worktree isolation enabled. Tool parameter updates on next pi session.");
    vi.clearAllMocks();
    apply("worktreeIsolation", "off");
    expect(isWorktreeIsolationEnabled()).toBe(false);
    expect(lastMessage()).toBe("Worktree isolation disabled. Tool parameter updates on next pi session.");
  });

  it("toolDescriptionMode", () => {
    apply("toolDescriptionMode", "compact");
    expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("compact");
    expect(lastMessage()).toBe("Tool description set to compact. Takes effect on next pi session.");
  });

  it("reportUsage", () => {
    apply("reportUsage", "on");
    expect(appliers.setReportUsage).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Subagent usage now counted in this session's totals");
    vi.clearAllMocks();
    apply("reportUsage", "off");
    expect(appliers.setReportUsage).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Subagent usage no longer counted in this session's totals");
  });

  it("showCost", () => {
    apply("showCost", "on");
    expect(appliers.setShowCost).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Cost display enabled");
    vi.clearAllMocks();
    apply("showCost", "off");
    expect(appliers.setShowCost).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Cost display disabled");
  });

  it("showModel", () => {
    apply("showModel", "on");
    expect(appliers.setShowModel).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Model display enabled");
    vi.clearAllMocks();
    apply("showModel", "off");
    expect(appliers.setShowModel).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Model display disabled");
  });

  it("viewerMarkdown", () => {
    apply("viewerMarkdown", "assistant");
    expect(appliers.setViewerMarkdown).toHaveBeenCalledWith("assistant");
    expect(lastMessage()).toBe("Viewer markdown set to assistant");
  });

  it("fleetView", () => {
    apply("fleetView", "on");
    expect(appliers.setFleetView).toHaveBeenCalledWith(true);
    expect(lastMessage()).toBe("Fleet view enabled");
    vi.clearAllMocks();
    apply("fleetView", "off");
    expect(appliers.setFleetView).toHaveBeenCalledWith(false);
    expect(lastMessage()).toBe("Fleet view disabled");
  });

  it.each([
    ["off", "Agent mentions disabled"],
    ["model", "Agent mentions on — a conversation clone starts a mentioned agent off-screen"],
    ["direct", "Agent mentions on — a mentioned agent starts here, with no model call"],
  ])("agentMentions %s", (mode, message) => {
    apply("agentMentions", mode);
    expect(appliers.setAgentMentions).toHaveBeenCalledWith(mode);
    expect(lastMessage()).toBe(message);
  });

  it("rememberAgents", () => {
    apply("rememberAgents", "on");
    expect(getRememberAgents()).toBe(true);
    expect(lastMessage()).toBe("Remember agents enabled");
    vi.clearAllMocks();
    apply("rememberAgents", "off");
    expect(getRememberAgents()).toBe(false);
    expect(lastMessage()).toBe("Remember agents disabled");
  });

  it("widgetMode", () => {
    apply("widgetMode", "background");
    expect(appliers.setWidgetMode).toHaveBeenCalledWith("background");
    expect(lastMessage()).toBe("Widget set to background");
  });

  it("unknown id is a silent no-op", () => {
    apply("nope", "on");
    expect(notifyApplied).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
