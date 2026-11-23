import { describe, expect, it, vi } from "vitest";
import { forgetWarning, setWarningSink, warn, warnOnce } from "../src/warnings.js";

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

  it("delivers a keyed warning once", () => {
    const sink = vi.fn();
    setWarningSink(sink);
    warnOnce("k", "same");
    warnOnce("k", "same");
    warnOnce("other", "different");
    expect(sink.mock.calls).toEqual([["same"], ["different"]]);
  });

  it("delivers a keyed warning again after it is forgotten", () => {
    const sink = vi.fn();
    setWarningSink(sink);
    warnOnce("k", "again");
    forgetWarning("k");
    warnOnce("k", "again");
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("never calls console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn("quiet");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
