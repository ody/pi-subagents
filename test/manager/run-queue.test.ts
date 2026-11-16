import { describe, expect, it } from "vitest";
import { enqueueRun, type QueuedRun } from "../../src/manager/run-queue.js";
import type { AgentRecord } from "../../src/types.js";

function queuedRecord(id: string): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: "test",
    status: "queued",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
  };
}

const noStart = async () => {};

describe("enqueueRun", () => {
  it("counts the runs ahead in the same pool only", () => {
    const queue: QueuedRun[] = [];
    expect(enqueueRun(queue, queuedRecord("b1"), "background", noStart)).toBe(0);
    expect(enqueueRun(queue, queuedRecord("f1"), "foreground", noStart)).toBe(0);
    expect(enqueueRun(queue, queuedRecord("b2"), "background", noStart)).toBe(1);
    expect(queue.map(entry => entry.id)).toEqual(["b1", "f1", "b2"]);
  });

  it("keeps the start function on the entry", () => {
    const queue: QueuedRun[] = [];
    const start = async () => {};
    enqueueRun(queue, queuedRecord("b1"), "background", start);
    expect(queue[0].start).toBe(start);
  });

  it("opens the start gate on release", async () => {
    const queue: QueuedRun[] = [];
    const record = queuedRecord("b1");
    enqueueRun(queue, record, "background", noStart);
    let opened = false;
    void record.startGate?.then(() => { opened = true; });
    await Promise.resolve();
    expect(opened).toBe(false);
    queue[0].release();
    await record.startGate;
    expect(opened).toBe(true);
  });
});
