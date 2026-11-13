import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveAndEmitChanged } = vi.hoisted(() => ({ saveAndEmitChanged: vi.fn() }));
vi.mock("../src/config/settings.js", () => ({ saveAndEmitChanged }));

import { createSettingsPersistence } from "../src/config/runtime-settings.js";
import type { SettingChange, SettingsAppliers } from "../src/config/settings.js";

const appliers = {} as SettingsAppliers;
const change: SettingChange = { layer: "project", key: "showCost", value: true };

function ui() {
  return { ui: { notify: vi.fn() } };
}

beforeEach(() => {
  saveAndEmitChanged.mockReset();
  saveAndEmitChanged.mockReturnValue({ message: "ok", level: "info" });
});

describe("createSettingsPersistence", () => {
  it("persist is silent on success and warns the ctx on failure", () => {
    const persist = createSettingsPersistence(appliers, vi.fn()).persist;
    const okCtx = ui();
    persist(okCtx as never, "changed", change);
    expect(okCtx.ui.notify).not.toHaveBeenCalled();

    saveAndEmitChanged.mockReturnValueOnce({ message: "warn", level: "warning" });
    const warnCtx = ui();
    persist(warnCtx as never, "changed", change);
    expect(warnCtx.ui.notify).toHaveBeenCalledWith("warn", "warning");
  });

  it("persist writes the one change it is given, not a snapshot", () => {
    const persist = createSettingsPersistence(appliers, vi.fn(), "/work").persist;
    persist(undefined, "changed", change);
    expect(saveAndEmitChanged).toHaveBeenCalledWith(change, "changed", expect.any(Function), appliers, "/work");
  });

  it("notifyApplied toasts whatever the write returned", () => {
    const { notifyApplied } = createSettingsPersistence(appliers, vi.fn());
    saveAndEmitChanged.mockReturnValueOnce({ message: "saved (session only)", level: "warning" });
    const ctx = ui();
    notifyApplied(ctx as never, "saved", change);
    expect(ctx.ui.notify).toHaveBeenCalledWith("saved (session only)", "warning");
  });

  it("passes the emit through to saveAndEmitChanged", () => {
    const emit = vi.fn();
    const { notifyApplied } = createSettingsPersistence(appliers, emit);
    notifyApplied(ui() as never, "saved", change);
    expect(saveAndEmitChanged.mock.calls[0][2]).toBe(emit);
  });
});
