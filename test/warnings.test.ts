import { describe, expect, it, vi } from "vitest";
import { setWarningSink, warn } from "../src/warnings.js";

describe("warnings", () => {
  it("buffers messages until a sink is set, then delivers them in order", () => {
    warn("first");
    warn("second");
    const sink = vi.fn();
    setWarningSink(sink);
    expect(sink.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("delivers straight to the sink once it is set", () => {
    const sink = vi.fn();
    setWarningSink(sink);
    warn("now");
    expect(sink).toHaveBeenCalledWith("now");
  });

  it("buffers again after the sink is removed, without replaying delivered messages", () => {
    const first = vi.fn();
    setWarningSink(first);
    warn("seen");
    setWarningSink(undefined);
    warn("held");
    const second = vi.fn();
    setWarningSink(second);
    expect(second.mock.calls).toEqual([["held"]]);
  });

  it("never calls console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn("quiet");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
