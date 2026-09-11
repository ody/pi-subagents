/**
 * abort-forced-settle.test.ts — the gap in `AgentManager.abort()`: firing the
 * AbortController and marking a record "stopped" does nothing else. Everything
 * else — releasing the run's pool slot, notifying, stopping owned children,
 * flushing the output file — lives in `settleRun`, which only runs once the
 * run's own promise settles. For an agent wedged inside a tool call that never
 * returns, that promise may never settle, so `abort()` alone leaks the slot,
 * withholds the notification, and leaves any nested children running forever.
 *
 * `forceSettle` closes that gap with a grace-period timer armed in `abort()`.
 * These tests pin its three observable effects and the double-settle guard
 * that keeps a late real settle from undoing them.
 *
 * Isolated in its own file, like `agent-manager-gc.test.ts`: fake timers need
 * to be installed before `new AgentManager()` (the constructor's cleanup
 * interval), and are hostile to the promise-settling style of the main suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() } as any);

const GRACE = 5_000;

/** A runAgent whose promise never settles — a permanently wedged agent. */
function wedge() {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
}

describe("AgentManager — abort() forced settle", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it("returns a wedged agent's background slot only after the grace period", async () => {
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    wedge();

    const id = manager.spawn(mockPi, mockCtx, "X", "wedged", { description: "d", isBackground: true });
    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)?.status).toBe("stopped");

    // Nothing has released the slot yet — a spawn now queues behind it.
    const tooSoonId = manager.spawn(mockPi, mockCtx, "Y", "too soon", { description: "d", isBackground: true });
    expect(manager.getRecord(tooSoonId)?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(GRACE);

    // The queued one drained into the freed slot; a fresh spawn now queues
    // behind IT instead, proving the slot returned exactly once.
    expect(manager.getRecord(tooSoonId)?.status).toBe("running");
    const afterId = manager.spawn(mockPi, mockCtx, "Z", "after", { description: "d", isBackground: true });
    expect(manager.getRecord(afterId)?.status).toBe("queued");
  });

  it("fires onComplete for a wedged agent once the grace period elapses", async () => {
    const completed: string[] = [];
    manager = new AgentManager((r) => completed.push(r.status));
    wedge();

    const id = manager.spawn(mockPi, mockCtx, "X", "wedged", { description: "d", isBackground: true });
    manager.abort(id);
    expect(completed).toEqual([]); // not yet — abort() alone doesn't notify

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]);
  });

  it("aborts a wedged parent's nested children once the grace period elapses", async () => {
    manager = new AgentManager();
    wedge();

    const parentId = manager.spawn(mockPi, mockCtx, "X", "parent", { description: "d", isBackground: true });
    const childId = manager.spawn(mockPi, mockCtx, "Y", "child", {
      description: "d",
      parentAgentId: parentId,
      isBackground: true,
    });
    expect(manager.getRecord(childId)?.status).toBe("running");

    manager.abort(parentId);
    // abort() itself doesn't reach for owned children — only the settle tail does.
    expect(manager.getRecord(childId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(manager.getRecord(childId)?.status).toBe("stopped");
  });

  it("a late real settle after the forced one does not double-decrement or double-notify", async () => {
    const completed: string[] = [];
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );
    // Every spawn AFTER the first stays wedged — enough to prove the slot
    // count without needing each one to ever finish.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager = new AgentManager((r) => completed.push(r.status), 1);
    const id1 = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    manager.abort(id1);

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]); // the forced settle, and only it, fired

    // The freed slot goes to a second (wedged) agent.
    const id2 = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "d", isBackground: true });
    expect(manager.getRecord(id2)?.status).toBe("running");

    // id1's real settle finally arrives, long after the forced one.
    resolveFirst({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(id1)?.promise;

    expect(completed).toEqual(["stopped"]); // no second onComplete call
    // A third spawn still queues — proving the late settle did not decrement
    // runningBackground a second time and silently lift the limit to 0.
    const id3 = manager.spawn(mockPi, mockCtx, "Z", "r", { description: "d", isBackground: true });
    expect(manager.getRecord(id3)?.status).toBe("queued");
  });
});
