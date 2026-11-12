import { afterEach, describe, expect, it, vi } from "vitest";
import { GrantingAgentManager as AgentManager } from "./helpers/capability.js";

vi.mock("../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/platform/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { pruneWorktrees } from "../src/platform/worktree.js";
import { runAgent } from "../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

function boundSession(emit: (...args: any[]) => any = vi.fn(async () => {})) {
  return {
    dispose: vi.fn(),
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(emit),
    },
  } as any;
}

async function spawnCompleted(manager: AgentManager, session: any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session,
    aborted: false,
    steered: false,
  } as any);
  const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
    description: "test",
    isBackground: true,
  });
  await manager.getRecord(id)!.promise;
  return id;
}

describe("child session shutdown (#242)", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("emits session_shutdown before disposing an evicted session", async () => {
    manager = new AgentManager();
    const session = boundSession();
    await spawnCompleted(manager, session);

    manager.clearCompleted();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalled());

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0])
      .toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it("quit waits for the child's shutdown handlers to finish", async () => {
    manager = new AgentManager();
    let releaseHandler!: () => void;
    const session = boundSession(() => new Promise<void>(r => { releaseHandler = r; }));
    await spawnCompleted(manager, session);

    const disposed = manager.dispose();
    let settled = false;
    void disposed.then(() => { settled = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    expect(session.dispose).not.toHaveBeenCalled();

    releaseHandler();
    await disposed;
    expect(settled).toBe(true);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("quit is not hostage to a handler that never resolves", async () => {
    manager = new AgentManager();
    const session = boundSession(() => new Promise<void>(() => {}));
    await spawnCompleted(manager, session);

    vi.useFakeTimers();
    const disposed = manager.dispose(mockPi);
    await vi.advanceTimersByTimeAsync(5_000);
    await disposed;

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(pruneWorktrees).toHaveBeenCalled();
  });

  it("skips the emit when no extension handles session_shutdown", async () => {
    manager = new AgentManager();
    const session = boundSession();
    session.extensionRunner.hasHandlers = vi.fn(() => false);
    await spawnCompleted(manager, session);

    manager.clearCompleted();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalled());

    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
  });

  it("degrades on a stubbed session instead of throwing", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      manager = new AgentManager();
      const noRunner = { dispose: vi.fn() } as any;
      await spawnCompleted(manager, noRunner);
      manager.clearCompleted();
      await vi.waitFor(() => expect(noRunner.dispose).toHaveBeenCalled());

      const empty = {} as any;
      await spawnCompleted(manager, empty);
      manager.clearCompleted();
      await expect(manager.dispose()).resolves.toBeUndefined();

      await new Promise(r => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
