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
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { createWorktree } from "../src/platform/worktree.js";
import { runAgent } from "../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;

function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
    new Promise<any>(resolve => {
      resolvers.set(prompt as string, () => resolve({
        responseText: `${prompt}-result`,
        session: mockSession(),
        aborted: false,
        steered: false,
      }));
    }),
  );
  return resolvers;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const fg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawnAndWait(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    ...options,
  });

const bg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    isBackground: true,
    ...options,
  });

const recordFor = (manager: AgentManager, prompt: string) =>
  manager.listAgents().find(a => a.description === prompt)!;

describe("maxConcurrentForeground", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  afterEach(() => {
    manager?.dispose();
    vi.mocked(createWorktree).mockReset();
  });

  it("is unlimited by default, and the default path stays synchronous", () => {
    controllableRuns();
    manager = new AgentManager();

    expect(manager.getMaxConcurrentForeground()).toBe(0);

    void fg(manager, "a");
    void fg(manager, "b");
    void fg(manager, "c");

    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const p of ["a", "b", "c"]) expect(recordFor(manager, p).status).toBe("running");
  });

  it("queues blocking spawns past the limit and starts them as slots free, in order", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const first = fg(manager, "a");
    const second = fg(manager, "b");
    const third = fg(manager, "c");

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(recordFor(manager, "b").status).toBe("queued");
    expect(recordFor(manager, "c").status).toBe("queued");

    resolvers.get("a")!();
    expect(await first).toMatchObject({ record: { status: "completed", result: "a-result" } });

    expect(recordFor(manager, "b").status).toBe("running");
    expect(recordFor(manager, "c").status).toBe("queued");

    resolvers.get("b")!();
    expect(await second).toMatchObject({ record: { result: "b-result" } });
    resolvers.get("c")!();
    expect(await third).toMatchObject({ record: { result: "c-result" } });
  });

  it("never queues a nested child, however full the pool is", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "parent");
    expect(recordFor(manager, "parent").status).toBe("running");

    void fg(manager, "child", { parentAgentId: recordFor(manager, "parent").id, depth: 2 });

    expect(recordFor(manager, "child").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("is independent of the background pool, in both directions", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentForeground(1);

    bg(manager, "bg1");
    bg(manager, "bg2");
    expect(recordFor(manager, "bg1").status).toBe("running");
    expect(recordFor(manager, "bg2").status).toBe("queued");

    void fg(manager, "fg1");
    expect(recordFor(manager, "fg1").status).toBe("running");

    void fg(manager, "fg2");
    expect(recordFor(manager, "fg2").status).toBe("queued");
    expect(recordFor(manager, "bg2").status).toBe("queued");
  });

  it("does not queue a detached spawn, even one flagged isBackground: false", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "holder");
    manager.spawn(mockPi, mockCtx, "general-purpose", "rpc", {
      description: "rpc",
      isBackground: false,
    });

    expect(recordFor(manager, "rpc").status).toBe("running");
  });

  it("starts a bypassQueue spawn at the limit, and still counts its slot", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "holder");
    void fg(manager, "scheduled", { bypassQueue: true });
    expect(recordFor(manager, "scheduled").status).toBe("running");

    void fg(manager, "next");
    expect(recordFor(manager, "next").status).toBe("queued");
  });

  describe("cancellation", () => {
    it("resolves — never rejects — when a queued agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");
      const victimId = recordFor(manager, "victim").id;

      expect(manager.abort(victimId)).toBe(true);

      const { record } = await queued;
      expect(record.status).toBe("stopped");
      expect(record.promise).toBeUndefined();
      expect(record.completedAt).toBeDefined();

      resolvers.get("holder")!();
      await flush();
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("releases a queued agent when the caller's signal aborts (Esc)", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const controller = new AbortController();
      const queued = fg(manager, "victim", { signal: controller.signal });
      expect(recordFor(manager, "victim").status).toBe("queued");

      controller.abort();
      expect((await queued).record.status).toBe("stopped");
    });

    it("never enqueues a spawn whose signal is already aborted", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const controller = new AbortController();
      controller.abort();

      const { record } = await fg(manager, "victim", { signal: controller.signal });
      expect(record.status).toBe("stopped");
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("stops an immediate spawn whose signal is already aborted, pool off", async () => {
      controllableRuns();
      manager = new AgentManager();
      expect(manager.getMaxConcurrentForeground()).toBe(0);

      const controller = new AbortController();
      controller.abort();
      void fg(manager, "doomed", { signal: controller.signal });

      expect(recordFor(manager, "doomed").status).toBe("stopped");
      expect(recordFor(manager, "doomed").abortController?.signal.aborted).toBe(true);
    });

    it("releases queued waiters on abortAll()", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");

      manager.abortAll();
      expect((await queued).record.status).toBe("stopped");
    });

    it("releases queued waiters on dispose()", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");

      await manager.dispose();
      await expect(queued).resolves.toBeDefined();
    });
  });

  describe("slot accounting", () => {
    it("frees the slot when a foreground agent fails", async () => {
      const rejectors = new Map<string, (e: unknown) => void>();
      vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
        new Promise<any>((_resolve, reject) => { rejectors.set(prompt as string, reject); }),
      );
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const first = fg(manager, "a");
      void fg(manager, "b");
      expect(recordFor(manager, "b").status).toBe("queued");

      rejectors.get("a")!(new Error("boom"));
      expect((await first).record.status).toBe("error");
      expect(recordFor(manager, "b").status).toBe("running");
    });

    it("frees the slot exactly once when a running agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const first = fg(manager, "a");
      void fg(manager, "b");
      void fg(manager, "c");

      manager.abort(recordFor(manager, "a").id);
      resolvers.get("a")!();
      await first;

      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  it("rethrows a drain-time startup failure, and keeps draining", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    vi.mocked(createWorktree).mockReturnValue(undefined as any);

    const first = fg(manager, "holder");
    const doomed = fg(manager, "doomed", { isolation: "worktree" });
    const after = fg(manager, "after");
    expect(recordFor(manager, "doomed").status).toBe("queued");

    resolvers.get("holder")!();
    await first;

    await expect(doomed).rejects.toThrow(/worktree/i);
    expect(recordFor(manager, "doomed").status).toBe("error");
    expect(recordFor(manager, "doomed").resultConsumed).toBe(true);

    expect(recordFor(manager, "after").status).toBe("running");
    resolvers.get("after")!();
    await after;
  });

  it("drains immediately when the limit is raised or cleared", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "a");
    void fg(manager, "b");
    void fg(manager, "c");
    expect(runAgent).toHaveBeenCalledTimes(1);

    manager.setMaxConcurrentForeground(0);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  describe("a limit changed mid-run", () => {
    it("releases the slot a cleared limit no longer describes", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const a = fg(manager, "a");
      manager.setMaxConcurrentForeground(0);
      resolvers.get("a")!();
      await a;
      await flush();

      manager.setMaxConcurrentForeground(1);
      void fg(manager, "b");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
    });

    it("does not release a slot a newly-set limit was never charged", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();

      const a = fg(manager, "a");
      manager.setMaxConcurrentForeground(1);
      resolvers.get("a")!();
      await a;
      await flush();

      void fg(manager, "b");
      void fg(manager, "c");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  it("clamps a negative limit to unlimited rather than to 1", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(-3);
    expect(manager.getMaxConcurrentForeground()).toBe(0);
  });

  it("counts a queued foreground agent as active, and waitForAll waits it out", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "a");
    void fg(manager, "b");
    expect(manager.hasRunning()).toBe(true);

    const all = manager.waitForAll();
    resolvers.get("a")!();
    await flush();
    resolvers.get("b")!();
    await all;

    expect(recordFor(manager, "b").status).toBe("completed");
  });

  it("fires each caller's onSpawned hook when its own deferred spawn starts", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const firstHook = vi.fn();
    const secondHook = vi.fn();

    const first = manager.spawnAndWait(
      mockPi, mockCtx, "general-purpose", "a", { description: "a" }, firstHook,
    );
    const second = manager.spawnAndWait(
      mockPi, mockCtx, "general-purpose", "b", { description: "b" }, secondHook,
    );

    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();

    resolvers.get("a")!();
    await first;

    expect(secondHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledWith(recordFor(manager, "b").id);
    expect(firstHook).toHaveBeenCalledTimes(1);

    resolvers.get("b")!();
    await second;
  });

  it("reports how many are ahead when a spawn is queued", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const onQueued = vi.fn();
    void fg(manager, "holder");
    void fg(manager, "b", { onQueued });
    void fg(manager, "c", { onQueued });

    expect(onQueued).toHaveBeenNthCalledWith(1, recordFor(manager, "b").id, 0);
    expect(onQueued).toHaveBeenNthCalledWith(2, recordFor(manager, "c").id, 1);
  });

  it("does not let a full foreground queue head-of-line-block the background pool", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "fg-holder");
    void fg(manager, "fg-queued");
    bg(manager, "bg-holder");
    bg(manager, "bg-queued");

    expect(recordFor(manager, "fg-queued").status).toBe("queued");
    expect(recordFor(manager, "bg-queued").status).toBe("queued");

    resolvers.get("bg-holder")!();
    await flush();

    expect(recordFor(manager, "bg-queued").status).toBe("running");
    expect(recordFor(manager, "fg-queued").status).toBe("queued");
  });
});
