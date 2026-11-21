import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantingAgentManager as AgentManager } from "./harness/capability.js";

vi.mock("../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/platform/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
  isWorktreeRetained: vi.fn(() => true),
}));

import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "../src/platform/worktree.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";

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
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReturnValue({ hasChanges: false } as any);
  });

  it("returns a wedged agent's background slot only after the grace period", async () => {
    manager = new AgentManager(undefined, 1);
    wedge();

    const id = manager.spawn(mockPi, mockCtx, "X", "wedged", { description: "d", isBackground: true });
    expect(manager.abort(id, "user")).toBe(true);
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
    manager.abort(id, "user");
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

    manager.abort(parentId, "user");
    expect(manager.getRecord(childId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(manager.getRecord(childId)?.status).toBe("stopped");
  });

  it("a late real settle after the forced one does not double-decrement or double-notify", async () => {
    const completed: string[] = [];
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res as (v: unknown) => void; }),
    );
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager = new AgentManager((r) => completed.push(r.status), 1);
    const id1 = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    manager.abort(id1, "user");

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]);

    const id2 = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "d", isBackground: true });
    expect(manager.getRecord(id2)?.status).toBe("running");

    resolveFirst({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(id1)?.promise;

    expect(completed).toEqual(["stopped"]);
    const id3 = manager.spawn(mockPi, mockCtx, "Z", "r", { description: "d", isBackground: true });
    expect(manager.getRecord(id3)?.status).toBe("queued");
  });

  it("records the late worktree cleanup after a forced settle without a second completion", async () => {
    const completed: string[] = [];
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }) as any);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "late-branch", path: "/tmp/wt" } as any);

    manager = new AgentManager((r) => completed.push(r.status));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    await vi.advanceTimersByTimeAsync(0);
    expect(record.status).toBe("running");

    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]);
    expect(record.result).toContain("/tmp/wt");
    expect(record.worktreeResult).toBeUndefined();
    expect(cleanupWorktree).not.toHaveBeenCalled();

    resolveRun({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(record.result).toContain("late-branch");
    expect(record.worktreeResult?.branch).toBe("late-branch");
    expect(record.status).toBe("stopped");
    expect(completed).toEqual(["stopped"]);
  });

  it("records the late worktree failure after a forced settle without a second completion", async () => {
    const completed: string[] = [];
    let rejectRun!: (reason: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRun = reject; }) as any);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    vi.mocked(cleanupWorktree).mockRejectedValue(new Error("disk gone"));

    manager = new AgentManager((r) => completed.push(r.status));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    await vi.advanceTimersByTimeAsync(0);
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["stopped"]);

    rejectRun(new Error("boom"));
    await record.promise;
    expect(record.worktreeResult).toMatchObject({ hasChanges: true, path: "/tmp/wt", failure: "disk gone" });
    expect(record.result).toContain("disk gone");
    expect(record.status).toBe("stopped");
    expect(completed).toEqual(["stopped"]);
  });

  it("blocks a second resume until a force-settled resumed run's late cleanup finishes", async () => {
    const completed: string[] = [];
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
    vi.mocked(createWorktree).mockResolvedValue({
      path: "/tmp/wt",
      branch: "b",
      baseSha: "abc",
      workPath: "/tmp/wt",
      repoPath: "/repo",
      pi: mockPi,
    } as any);
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "saved-branch", path: "/tmp/wt" } as any);

    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }) as any);

    manager = new AgentManager((r) => completed.push(r.status));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    await vi.advanceTimersByTimeAsync(0);
    resolveRun({ responseText: "first", session: mockSession(), aborted: false, steered: false });
    await record.promise;
    expect(record.worktreeResult?.branch).toBe("saved-branch");

    let resolveResume!: (v: unknown) => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise((resolve) => { resolveResume = resolve; }) as any);
    expect(await manager.resume(id, "again", undefined, { isBackground: true })).toBeDefined();
    expect(record.worktreeResult).toBeUndefined();

    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["completed", "stopped"]);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();

    resolveResume({ text: "late resume", failure: undefined });
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(record.worktreeResult?.branch).toBe("saved-branch");
    expect(record.status).toBe("stopped");
    expect(completed).toEqual(["completed", "stopped"]);

    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(() => {}) as any);
    expect(await manager.resume(id, "again 2", undefined, { isBackground: true })).toBeDefined();
    expect(record.status).toBe("running");
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
    manager.abort(id, "user");
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

    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);

    expect(record.result).toBe("the real result");
  });
});
