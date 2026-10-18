import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/types.js";
import { detailMenuOptions } from "../src/ui/agents-menu.js";

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

  it("disabled default with file offers reset", () => {
    expect(detailMenuOptions(cfg({ isDefault: true, enabled: false }), true)).toEqual(["Enable", "Edit", "Reset to default", "Delete", "Back"]);
  });

  it("disabled custom with file has no reset", () => {
    expect(detailMenuOptions(cfg({ enabled: false }), true)).toEqual(["Enable", "Edit", "Delete", "Back"]);
  });

  it("default without file offers eject", () => {
    expect(detailMenuOptions(cfg({ isDefault: true }), false)).toEqual(["Eject (export as .md)", "Disable", "Back"]);
  });

  it("default with file offers edit and reset", () => {
    expect(detailMenuOptions(cfg({ isDefault: true }), true)).toEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
  });

  it("custom agent", () => {
    expect(detailMenuOptions(cfg({}), true)).toEqual(["Edit", "Disable", "Delete", "Back"]);
  });
});
