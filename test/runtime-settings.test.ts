// runtime-settings.ts: the settings snapshot and the two settings-write paths.
// saveAndEmitChanged is mocked so no test writes a real subagents.json.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveAndEmitChanged } = vi.hoisted(() => ({ saveAndEmitChanged: vi.fn() }));
vi.mock("../src/settings.js", () => ({ saveAndEmitChanged }));

import { createSettingsPersistence, type RuntimeSettings, snapshotSettings } from "../src/runtime-settings.js";

function runtimeSettings(over: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    reportUsage: false,
    showCost: false,
    showModel: false,
    viewerMarkdown: "assistant",
    widgetMode: "all",
    fleetView: true,
    agentMentionMode: "model",
    defaultJoinMode: "smart",
    backgroundByDefault: true,
    schedulingEnabled: true,
    toolDescriptionMode: "full",
    strictAgentFiles: false,
    ...over,
  };
}

const manager = {
  getMaxConcurrent: () => 7,
  getMaxConcurrentForeground: () => 3,
};

function ui() {
  return { ui: { notify: vi.fn() } };
}

beforeEach(() => {
  saveAndEmitChanged.mockReset();
  saveAndEmitChanged.mockReturnValue({ message: "ok", level: "info" });
});

describe("snapshotSettings", () => {
  it("maps the in-memory fields to their SubagentsSettings keys", () => {
    const s = snapshotSettings(
      runtimeSettings({ defaultJoinMode: "async", agentMentionMode: "direct", viewerMarkdown: "all" }),
      { manager },
    );
    expect(s.defaultJoinMode).toBe("async");
    expect(s.agentMentions).toBe("direct");
    expect(s.viewerMarkdown).toBe("all");
  });

  it("takes concurrency from the manager", () => {
    const s = snapshotSettings(runtimeSettings(), { manager });
    expect(s.maxConcurrent).toBe(7);
    expect(s.maxConcurrentForeground).toBe(3);
  });

  it("materializes no implicit fallbackSubagent default", () => {
    const s = snapshotSettings(runtimeSettings(), { manager });
    expect("fallbackSubagent" in s).toBe(true);
    expect(s.fallbackSubagent).toBeUndefined();
  });
});

describe("createSettingsPersistence", () => {
  it("persist is silent on success and warns the ctx on failure", () => {
    const persist = createSettingsPersistence(runtimeSettings(), { manager }, vi.fn()).persist;
    const okCtx = ui();
    persist(okCtx as never, "changed");
    expect(okCtx.ui.notify).not.toHaveBeenCalled();

    saveAndEmitChanged.mockReturnValueOnce({ message: "warn", level: "warning" });
    const warnCtx = ui();
    persist(warnCtx as never, "changed");
    expect(warnCtx.ui.notify).toHaveBeenCalledWith("warn", "warning");
  });

  it("persist writes the whole snapshot", () => {
    const persist = createSettingsPersistence(runtimeSettings({ showCost: true }), { manager }, vi.fn()).persist;
    persist(undefined, "changed");
    const snapshot = saveAndEmitChanged.mock.calls[0][0];
    expect(snapshot.showCost).toBe(true);
    expect(snapshot.maxConcurrent).toBe(7);
    expect(saveAndEmitChanged.mock.calls[0][1]).toBe("changed");
  });

  it("notifyApplied toasts whatever the write returned", () => {
    const { notifyApplied } = createSettingsPersistence(runtimeSettings(), { manager }, vi.fn());
    saveAndEmitChanged.mockReturnValueOnce({ message: "saved (session only)", level: "warning" });
    const ctx = ui();
    notifyApplied(ctx as never, "saved");
    expect(ctx.ui.notify).toHaveBeenCalledWith("saved (session only)", "warning");
  });

  it("passes the emit through to saveAndEmitChanged", () => {
    const emit = vi.fn();
    const { notifyApplied } = createSettingsPersistence(runtimeSettings(), { manager }, emit);
    notifyApplied(ui() as never, "saved");
    expect(saveAndEmitChanged.mock.calls[0][2]).toBe(emit);
  });
});
