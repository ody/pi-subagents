import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySettingValue, type SettingsMenuDeps, showSettings } from "../src/ui/settings-menu.js";

const manager = {
  getMaxConcurrent: vi.fn(),
  getMaxConcurrentForeground: vi.fn(),
};
const notifyApplied = vi.fn();
const notify = vi.fn();

const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
const deps = {
  settings: {
    defaultJoinMode: "smart",
    backgroundByDefault: true,
    reportUsage: false,
    showCost: false,
    showModel: false,
    viewerMarkdown: "assistant",
    fleetView: true,
    agentMentionMode: "model",
    widgetMode: "all",
    toolDescriptionMode: "full",
  } as unknown as SettingsMenuDeps["settings"],
  manager,
  settingsPersist: { notifyApplied },
  isStrictAgentFiles: () => false,
} as SettingsMenuDeps;

function apply(id: string, value: string) {
  applySettingValue(ctx, deps, id, value);
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
    ["joinMode", "smart", "defaultJoinMode", "smart", "Default join mode set to smart"],
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

  beforeEach(() => {
    manager.getMaxConcurrent.mockReturnValue(4);
    manager.getMaxConcurrentForeground.mockReturnValue(2);
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
      layer: "project",
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
    custom.mockResolvedValueOnce("joinMode");
    await showSettings(promptCtx, deps);
    expect(input).not.toHaveBeenCalled();
  });
});
