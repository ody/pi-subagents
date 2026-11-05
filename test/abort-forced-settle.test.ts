import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/manager/agent-manager.js";

vi.mock("../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/platform/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { runAgent } from "../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() } as any);

const GRACE = 5_000;

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
    manager = new AgentManager(undefined, 1);
    wedge();

    const id = manager.spawn(mockPi, mockCtx, "X", "wedged", { description: "d", isBackground: true });
    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)?.status).toBe("stopped");

    const tooSoonId = manager.spawn(mockPi, mockCtx, "Y", "too soon", { description: "d", isBackground: true });
    expect(manager.getRecord(tooSoonId)?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(GRACE);

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
    expect(completed).toEqual([]);

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
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager = new AgentManager((r) => completed.push(r.status), 1);
    const id1 = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    manager.abort(id1);

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]);

    const id2 = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "d", isBackground: true });
    expect(manager.getRecord(id2)?.status).toBe("running");

    // id1's real settle finally arrives, long after the forced one.
    resolveFirst({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(id1)?.promise;

    expect(completed).toEqual(["stopped"]);
    const id3 = manager.spawn(mockPi, mockCtx, "Z", "r", { description: "d", isBackground: true });
    expect(manager.getRecord(id3)?.status).toBe("queued");
  });

  it("copies the streamed response text into record.result when no result exists", async () => {
    vi.mocked(runAgent).mockImplementation(
      ((_ctx: any, _type: any, _prompt: any, opts: any) => new Promise(() => {
        opts.onTextDelta?.("partial", "  partial answer  ");
      })) as any,
    );
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "X", "wedged", { description: "d", isBackground: true });
    await vi.advanceTimersByTimeAsync(0);
    manager.abort(id);
    expect(manager.getRecord(id)?.result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(manager.getRecord(id)?.result).toBe("partial answer");
  });

  it("keeps an existing result rather than overwriting it with the streamed text", async () => {
    vi.mocked(runAgent).mockImplementation(
      ((_ctx: any, _type: any, _prompt: any, opts: any) => new Promise(() => {
        opts.onTextDelta?.("partial", "partial answer");
      })) as any,
    );
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    record.result = "the real result";

    manager.abort(id);
    await vi.advanceTimersByTimeAsync(GRACE);

    expect(record.result).toBe("the real result");
  });
});
