import { describe, expect, it, vi } from "vitest";
import { armQueuedAbort, assertSignalCause, watchParentSignal } from "../../src/manager/parent-signal.js";
import type { AgentRecord } from "../../src/types.js";

function recordWith(controller: AbortController): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "test",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    abortController: controller,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
  };
}

describe("assertSignalCause", () => {
  it("accepts a call without a signal", () => {
    expect(() => assertSignalCause("spawn", undefined, undefined)).not.toThrow();
  });

  it("accepts a signal with a cause", () => {
    expect(() => assertSignalCause("spawn", new AbortController().signal, "owner")).not.toThrow();
  });

  it.each(["spawn", "resume"] as const)("refuses a %s with a signal and no cause", (action) => {
    expect(() => assertSignalCause(action, new AbortController().signal, undefined))
      .toThrow(`A ${action} with a signal needs signalCause, the stop cause of the signal's owner.`);
  });
});

describe("armQueuedAbort", () => {
  it("does nothing without a signal or a cause", () => {
    const abort = vi.fn(() => true);
    expect(armQueuedAbort(abort, "a1", undefined, "user")).toBe(true);
    expect(armQueuedAbort(abort, "a1", new AbortController().signal, undefined)).toBe(true);
    expect(abort).not.toHaveBeenCalled();
  });

  it("stops at once when the signal has already aborted", () => {
    const abort = vi.fn(() => true);
    const parent = new AbortController();
    parent.abort();
    expect(armQueuedAbort(abort, "a1", parent.signal, "owner")).toBe(false);
    expect(abort).toHaveBeenCalledWith("a1", "owner");
  });

  it("stops when the signal aborts later", () => {
    const abort = vi.fn(() => true);
    const parent = new AbortController();
    expect(armQueuedAbort(abort, "a1", parent.signal, "user")).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    parent.abort();
    expect(abort).toHaveBeenCalledWith("a1", "user");
  });
});

describe("watchParentSignal", () => {
  it("returns no detach without a signal or a cause", () => {
    const controller = new AbortController();
    const record = recordWith(controller);
    expect(watchParentSignal(vi.fn(() => true), record, controller, undefined, "owner")).toBeUndefined();
    expect(watchParentSignal(vi.fn(() => true), record, controller, new AbortController().signal, undefined)).toBeUndefined();
  });

  it("stops the run that armed it", () => {
    const abort = vi.fn(() => true);
    const controller = new AbortController();
    const parent = new AbortController();
    watchParentSignal(abort, recordWith(controller), controller, parent.signal, "owner");
    parent.abort();
    expect(abort).toHaveBeenCalledWith("a1", "owner");
  });

  it("leaves a newer run alone", () => {
    const abort = vi.fn(() => true);
    const controller = new AbortController();
    const record = recordWith(controller);
    const parent = new AbortController();
    watchParentSignal(abort, record, controller, parent.signal, "owner");
    record.abortController = new AbortController();
    parent.abort();
    expect(abort).not.toHaveBeenCalled();
  });

  it("stops listening after detach", () => {
    const abort = vi.fn(() => true);
    const controller = new AbortController();
    const parent = new AbortController();
    const detach = watchParentSignal(abort, recordWith(controller), controller, parent.signal, "owner");
    detach?.();
    parent.abort();
    expect(abort).not.toHaveBeenCalled();
  });
});
