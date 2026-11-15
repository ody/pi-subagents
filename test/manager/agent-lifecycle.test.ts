import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";
import { GrantingAgentManager as AgentManager } from "../harness/capability.js";

vi.mock("../../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../../src/platform/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { cleanupWorktree, createWorktree } from "../../src/platform/worktree.js";
import { runAgent } from "../../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const GRACE = 5_000;

interface SlotCounts {
  runningBackground: number;
  runningForeground: number;
}

interface Deferred {
  resolve: (value: Awaited<ReturnType<typeof runAgent>>) => void;
  reject: (reason: unknown) => void;
}

interface PoolCase {
  name: string;
  options: { isBackground: boolean; blocking?: boolean };
  setup: (manager: AgentManager) => void;
  counter: keyof SlotCounts | undefined;
}

const POOLS: PoolCase[] = [
  { name: "background pool", options: { isBackground: true }, setup: () => {}, counter: "runningBackground" },
  {
    name: "foreground pool",
    options: { isBackground: false, blocking: true },
    setup: manager => manager.setMaxConcurrentForeground(1),
    counter: "runningForeground",
  },
  { name: "no pool", options: { isBackground: false }, setup: () => {}, counter: undefined },
];

const mockSession = () => ({ dispose: vi.fn() } as any);

const result = (extra: { aborted?: boolean; steered?: boolean; failure?: string } = {}) => ({
  responseText: "done",
  session: mockSession(),
  aborted: false,
  steered: false,
  ...extra,
});

function slots(manager: AgentManager): SlotCounts {
  return manager as unknown as SlotCounts;
}

let runs: Deferred[];

function controlledRuns() {
  runs = [];
  vi.mocked(runAgent).mockImplementation(
    () => new Promise((resolve, reject) => { runs.push({ resolve, reject }); }),
  );
}

describe("AgentManager — spawn run endings settle once", () => {
  let manager: AgentManager;
  let completed: AgentRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    controlledRuns();
    completed = [];
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReturnValue({ hasChanges: false } as any);
  });

  for (const pool of POOLS) {
    describe(pool.name, () => {
      function start() {
        manager = new AgentManager(record => completed.push(record), 1);
        pool.setup(manager);
        const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", ...pool.options });
        return { id, record: manager.getRecord(id)! };
      }

      function expectSettledOnce(status: AgentRecord["status"]) {
        expect(completed.map(r => r.status)).toEqual([status]);
        expect(slots(manager).runningBackground).toBe(0);
        expect(slots(manager).runningForeground).toBe(0);
      }

      it("holds one slot while running", () => {
        start();
        expect(slots(manager).runningBackground).toBe(pool.counter === "runningBackground" ? 1 : 0);
        expect(slots(manager).runningForeground).toBe(pool.counter === "runningForeground" ? 1 : 0);
      });

      it("settles a completed run", async () => {
        const { record } = start();
        runs[0].resolve(result());
        await record.promise;
        expect(record.status).toBe("completed");
        expect(record.completedAt).toBeDefined();
        expect(record.result).toBe("done");
        expectSettledOnce("completed");
      });

      it("settles a steered run", async () => {
        const { record } = start();
        runs[0].resolve(result({ steered: true }));
        await record.promise;
        expectSettledOnce("steered");
      });

      it("settles an aborted run", async () => {
        const { record } = start();
        runs[0].resolve(result({ aborted: true }));
        await record.promise;
        expectSettledOnce("aborted");
      });

      it("settles a failed run", async () => {
        const { record } = start();
        runs[0].reject(new Error("boom"));
        await record.promise;
        expect(record.error).toBe("boom");
        expectSettledOnce("error");
      });

      it("settles a failure reported by the runner", async () => {
        const { record } = start();
        runs[0].resolve(result({ failure: "model failed" }));
        await record.promise;
        expect(record.error).toBe("model failed");
        expectSettledOnce("error");
      });

      it("keeps stopped when a run is stopped while running and then resolves", async () => {
        const { id, record } = start();
        manager.abort(id);
        runs[0].resolve(result({ aborted: true }));
        await record.promise;
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
      });

      it("keeps stopped when a stopped run rejects", async () => {
        const { id, record } = start();
        manager.abort(id);
        runs[0].reject(new Error("aborted"));
        await record.promise;
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
      });

      it("settles a wedged run through the forced settle", async () => {
        const { id, record } = start();
        manager.abort(id);
        expect(completed).toEqual([]);
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
        expect(record.settled).toBe(true);
      });

      it("does not settle again when a forced run resolves late", async () => {
        const { id, record } = start();
        manager.abort(id);
        await vi.advanceTimersByTimeAsync(GRACE);
        runs[0].resolve(result());
        await record.promise;
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
      });

      it("flushes the output file once on a normal ending", async () => {
        const { record } = start();
        const flush = vi.fn();
        record.outputCleanup = flush;
        runs[0].resolve(result());
        await record.promise;
        expect(flush).toHaveBeenCalledTimes(1);
        expect(record.outputCleanup).toBeUndefined();
      });

      it("flushes the output file once on a forced settle", async () => {
        const { id, record } = start();
        const flush = vi.fn();
        record.outputCleanup = flush;
        manager.abort(id);
        await vi.advanceTimersByTimeAsync(GRACE);
        runs[0].resolve(result());
        await record.promise;
        expect(flush).toHaveBeenCalledTimes(1);
      });

      it("stops owned children before the completion callback", async () => {
        let childStatusAtCallback: AgentRecord["status"] | undefined;
        let childId = "";
        manager = new AgentManager(r => {
          completed.push(r);
          childStatusAtCallback = manager.getRecord(childId)?.status;
        }, 1);
        pool.setup(manager);
        const parentId = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", ...pool.options });
        childId = manager.spawn(mockPi, mockCtx, "Y", "c", {
          description: "d",
          parentAgentId: parentId,
          isBackground: true,
        });
        runs[0].resolve(result());
        await manager.getRecord(parentId)?.promise;
        expect(childStatusAtCallback).toBe("stopped");
        expect(manager.getRecord(childId)?.status).toBe("stopped");
      });

      it("detaches the parent abort signal when the run settles", async () => {
        manager = new AgentManager(record => completed.push(record), 1);
        pool.setup(manager);
        const controller = new AbortController();
        const detach = vi.spyOn(controller.signal, "removeEventListener");
        const id = manager.spawn(mockPi, mockCtx, "X", "p", {
          description: "d",
          signal: controller.signal,
          ...pool.options,
        });
        runs[0].resolve(result());
        await manager.getRecord(id)?.promise;
        expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
        expectSettledOnce("completed");
      });
    });
  }

  describe("queue", () => {
    it("starts the next queued run when a run settles", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const first = manager.spawn(mockPi, mockCtx, "X", "a", { description: "d", isBackground: true });
      const second = manager.spawn(mockPi, mockCtx, "X", "b", { description: "d", isBackground: true });
      expect(manager.getRecord(second)?.status).toBe("queued");
      runs[0].resolve(result());
      await manager.getRecord(first)?.promise;
      expect(manager.getRecord(second)?.status).toBe("running");
      expect(slots(manager).runningBackground).toBe(1);
    });

    it("starts the next queued foreground run when a run settles", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      manager.setMaxConcurrentForeground(1);
      const options = { description: "d", isBackground: false, blocking: true };
      const first = manager.spawn(mockPi, mockCtx, "X", "a", options);
      const second = manager.spawn(mockPi, mockCtx, "X", "b", options);
      expect(manager.getRecord(second)?.status).toBe("queued");
      runs[0].resolve(result());
      await manager.getRecord(first)?.promise;
      expect(manager.getRecord(second)?.status).toBe("running");
      expect(slots(manager).runningForeground).toBe(1);
    });
  });

  describe("result consumption", () => {
    it("marks a foreground run's result consumed before the callback", async () => {
      let consumedAtCallback: boolean | undefined;
      manager = new AgentManager(record => { consumedAtCallback = record.resultConsumed; });
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: false });
      runs[0].resolve(result());
      await manager.getRecord(id)?.promise;
      expect(consumedAtCallback).toBe(true);
    });

    it("leaves a background run's result unconsumed", async () => {
      manager = new AgentManager();
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      runs[0].resolve(result());
      await manager.getRecord(id)?.promise;
      expect(manager.getRecord(id)?.resultConsumed).toBeFalsy();
    });
  });

  describe("worktree", () => {
    const worktree = { path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" };

    beforeEach(() => {
      vi.mocked(createWorktree).mockResolvedValue(worktree as any);
    });

    async function startIsolated() {
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
      await vi.advanceTimersByTimeAsync(0);
      return { id, record: manager.getRecord(id)! };
    }

    it("saves the worktree and notes the branch when a run resolves", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "saved-branch" } as any);
      const { record } = await startIsolated();
      runs[0].resolve(result());
      await record.promise;
      expect(record.result).toContain("saved-branch");
      expect(record.worktreeResult?.branch).toBe("saved-branch");
      expect(completed).toHaveLength(1);
    });

    it("adds the worktree path to the result on a forced settle", async () => {
      const { id, record } = await startIsolated();
      manager.abort(id);
      expect(cleanupWorktree).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(record.result).toContain("/tmp/wt");
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(completed).toHaveLength(1);
    });

    it("saves the worktree after a forced settle when the run resolves late", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "late-branch" } as any);
      const { id, record } = await startIsolated();
      manager.abort(id);
      await vi.advanceTimersByTimeAsync(GRACE);
      runs[0].resolve(result());
      await record.promise;
      expect(cleanupWorktree).toHaveBeenCalledTimes(1);
      expect(record.result).toContain("late-branch");
      expect(record.status).toBe("stopped");
      expect(completed).toHaveLength(1);
      expect(slots(manager).runningBackground).toBe(0);
    });

    it("does not add a worktree note on a forced settle without a worktree", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      manager.abort(id);
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(manager.getRecord(id)?.result).toBeUndefined();
    });
  });
});
