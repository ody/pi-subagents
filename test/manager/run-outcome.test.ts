import { describe, expect, it } from "vitest";
import { recordRunError, recordRunOutcome } from "../../src/manager/run-outcome.js";
import type { AgentRecord } from "../../src/types.js";

function runningRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "test",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("recordRunOutcome", () => {
  it.each([
    [{ text: "done" }, "completed"],
    [{ text: "done", steered: true }, "steered"],
    [{ text: "done", aborted: true }, "aborted"],
    [{ text: "done", failure: "boom" }, "error"],
    [{ text: "done", aborted: true, failure: "boom" }, "aborted"],
  ] as const)("maps %o to %s", (outcome, status) => {
    const record = runningRecord();
    recordRunOutcome(record, outcome);
    expect(record.status).toBe(status);
    expect(record.result).toBe("done");
  });

  it("stores the failure only when the run was not aborted", () => {
    const failed = runningRecord();
    recordRunOutcome(failed, { text: "", failure: "boom" });
    expect(failed.error).toBe("boom");

    const aborted = runningRecord();
    recordRunOutcome(aborted, { text: "", aborted: true, failure: "boom" });
    expect(aborted.error).toBeUndefined();
  });

  it("stores the provider stage only with a failure the run did not abort", () => {
    const failed = runningRecord();
    recordRunOutcome(failed, { text: "", failure: "boom", failureStage: "provider" });
    expect(failed.failureStage).toBe("provider");

    const aborted = runningRecord();
    recordRunOutcome(aborted, { text: "", aborted: true, failure: "boom", failureStage: "provider" });
    expect(aborted.failureStage).toBeUndefined();

    const stopped = runningRecord({ status: "stopped" });
    recordRunOutcome(stopped, { text: "", failure: "boom", failureStage: "provider" });
    expect(stopped.failureStage).toBeUndefined();
  });

  it("keeps a stopped status and its error", () => {
    const record = runningRecord({ status: "stopped" });
    recordRunOutcome(record, { text: "partial", failure: "boom" });
    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    expect(record.result).toBe("partial");
  });

  it("keeps an earlier completedAt", () => {
    const record = runningRecord({ completedAt: 42 });
    recordRunOutcome(record, { text: "done" });
    expect(record.completedAt).toBe(42);
  });

  it("sets completedAt when none exists", () => {
    const record = runningRecord();
    recordRunOutcome(record, { text: "done" });
    expect(record.completedAt).toBeTypeOf("number");
  });
});

describe("recordRunError", () => {
  it("marks a running record as failed with the error message", () => {
    const record = runningRecord();
    recordRunError(record, new Error("boom"));
    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeTypeOf("number");
  });

  it("stringifies a thrown value that is not an Error", () => {
    const record = runningRecord();
    recordRunError(record, "plain");
    expect(record.error).toBe("plain");
  });

  it("keeps a stopped status but records the error", () => {
    const record = runningRecord({ status: "stopped", completedAt: 42 });
    recordRunError(record, new Error("boom"));
    expect(record.status).toBe("stopped");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBe(42);
  });
});
