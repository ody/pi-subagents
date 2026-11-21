import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord, StopCause } from "../../src/types.js";
import { GrantingAgentManager as AgentManager } from "../harness/capability.js";

vi.mock("../../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../../src/platform/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  isWorktreeRetained: vi.fn(() => true),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { cleanupWorktree, createWorktree, isWorktreeRetained } from "../../src/platform/worktree.js";
import { resumeAgent, runAgent } from "../../src/session/agent-runner.js";

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
    vi.mocked(isWorktreeRetained).mockReturnValue(true);
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
        manager.abort(id, "user");
        runs[0].resolve(result({ aborted: true }));
        await record.promise;
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
      });

      it("keeps stopped when a stopped run rejects", async () => {
        const { id, record } = start();
        manager.abort(id, "user");
        runs[0].reject(new Error("aborted"));
        await record.promise;
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
      });

      it("settles a wedged run through the forced settle", async () => {
        const { id, record } = start();
        manager.abort(id, "user");
        expect(completed).toEqual([]);
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
        expect(record.settled).toBe(true);
      });

      it("does not settle again when a forced run resolves late", async () => {
        const { id, record } = start();
        manager.abort(id, "user");
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
        manager.abort(id, "user");
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
          signalCause: "user",
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

    it("notes a saved branch and a residual removal failure together", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({
        hasChanges: true,
        branch: "saved-branch",
        path: "/tmp/wt",
        removalFailure: "worktree is busy",
      } as any);
      const { record } = await startIsolated();
      runs[0].resolve(result());
      await record.promise;
      expect(record.result).toContain("Changes saved to branch `saved-branch`");
      expect(record.result).toContain("could not be removed: worktree is busy");
      expect(record.result).toContain("/tmp/wt");
      expect(record.worktreeResult).toMatchObject({ branch: "saved-branch", removalFailure: "worktree is busy" });
    });

    it("notes unknown changes and the path when the worktree is gone", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, path: "/tmp/wt", unknownChanges: true } as any);
      const { record } = await startIsolated();
      runs[0].resolve(result());
      await record.promise;
      expect(record.result).toContain("no longer exists");
      expect(record.result).toContain("/tmp/wt");
      expect(record.result).not.toContain("Changes saved to branch");
      expect(record.worktreeResult).toMatchObject({ unknownChanges: true, path: "/tmp/wt" });
    });

    it("adds the worktree path to the result on a forced settle", async () => {
      const { id, record } = await startIsolated();
      manager.abort(id, "user");
      expect(cleanupWorktree).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(record.result).toContain("/tmp/wt");
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(completed).toHaveLength(1);
    });

    it("saves the worktree after a forced settle when the run resolves late", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "late-branch" } as any);
      const { id, record } = await startIsolated();
      manager.abort(id, "user");
      await vi.advanceTimersByTimeAsync(GRACE);
      runs[0].resolve(result());
      await record.promise;
      expect(cleanupWorktree).toHaveBeenCalledTimes(1);
      expect(record.result).toContain("late-branch");
      expect(record.worktreeResult?.branch).toBe("late-branch");
      expect(record.status).toBe("stopped");
      expect(completed).toHaveLength(1);
      expect(slots(manager).runningBackground).toBe(0);
    });

    it("saves the worktree and notes the branch when a run fails", async () => {
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "failed-branch" } as any);
      const { record } = await startIsolated();
      runs[0].reject(new Error("boom"));
      await record.promise;
      expect(record.status).toBe("error");
      expect(record.error).toBe("boom");
      expect(record.result).toContain("failed-branch");
      expect(record.worktreeResult?.branch).toBe("failed-branch");
      expect(completed).toHaveLength(1);
    });

    it("reports the path and error when cleanup throws on a failed run", async () => {
      vi.mocked(cleanupWorktree).mockRejectedValue(new Error("disk gone"));
      const { record } = await startIsolated();
      runs[0].reject(new Error("boom"));
      await record.promise;
      expect(record.worktreeResult).toMatchObject({ hasChanges: true, path: "/tmp/wt", failure: "disk gone" });
      expect(record.result).toContain("disk gone");
      expect(record.result).toContain("/tmp/wt");
      expect(completed).toHaveLength(1);
    });

    it("saves the worktree when a run stops before it starts", async () => {
      let resolveWorktree!: (value: unknown) => void;
      vi.mocked(createWorktree).mockImplementation(
        () => new Promise((resolve) => { resolveWorktree = resolve; }) as any,
      );
      vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "early-branch" } as any);
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
      const record = manager.getRecord(id)!;
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.abort(id, "user")).toBe(true);

      resolveWorktree(worktree);
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(record.promise).toBeUndefined();
      expect(cleanupWorktree).toHaveBeenCalledTimes(1);
      expect(record.result).toContain("early-branch");
      expect(record.worktreeResult?.branch).toBe("early-branch");
      expect(record.status).toBe("stopped");
      expect(completed).toHaveLength(1);
    });

    it("does not add a worktree note on a forced settle without a worktree", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      manager.abort(id, "user");
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(manager.getRecord(id)?.result).toBeUndefined();
    });
  });
});

interface ResumeRun {
  resolve: (value: { text: string; failure?: string }) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
}

interface ResumePoolCase {
  name: string;
  options: { isBackground: true } | undefined;
  setup: (manager: AgentManager) => void;
  counter: keyof SlotCounts | undefined;
}

const RESUME_POOLS: ResumePoolCase[] = [
  { name: "background pool", options: { isBackground: true }, setup: () => {}, counter: "runningBackground" },
  {
    name: "foreground pool",
    options: undefined,
    setup: manager => manager.setMaxConcurrentForeground(1),
    counter: "runningForeground",
  },
  { name: "no pool", options: undefined, setup: () => {}, counter: undefined },
];

let resumes: ResumeRun[];

function controlledResumes() {
  resumes = [];
  vi.mocked(resumeAgent).mockImplementation(
    (_session, _prompt, options) => new Promise((resolve, reject) => {
      resumes.push({ resolve, reject, signal: options?.signal });
    }),
  );
}

describe("AgentManager — resume run endings settle once", () => {
  let manager: AgentManager;
  let completed: AgentRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    controlledRuns();
    controlledResumes();
    completed = [];
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReturnValue({ hasChanges: false } as any);
    vi.mocked(isWorktreeRetained).mockReturnValue(true);
  });

  async function spawnSettled(options: { isBackground: boolean; blocking?: boolean } = { isBackground: false }) {
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", ...options });
    const record = manager.getRecord(id)!;
    runs[runs.length - 1].resolve(result());
    await record.promise;
    completed.length = 0;
    return { id, record };
  }

  for (const pool of RESUME_POOLS) {
    describe(pool.name, () => {
      async function start() {
        manager = new AgentManager(record => completed.push(record), 1);
        pool.setup(manager);
        const { id, record } = await spawnSettled();
        const pending = manager.resume(id, "again", undefined, pool.options);
        const finish = async () => {
          await pending;
          await record.promise;
        };
        return { id, record, pending, finish };
      }

      function expectSettledOnce(status: AgentRecord["status"]) {
        expect(completed.map(r => r.status)).toEqual([status]);
        expect(slots(manager).runningBackground).toBe(0);
        expect(slots(manager).runningForeground).toBe(0);
      }

      it("sets the run's own flags and holds one slot while running", async () => {
        const { record } = await start();
        expect(record.status).toBe("running");
        expect(record.isBackground).toBe(pool.options !== undefined);
        expect(record.blocking).toBe(pool.options === undefined);
        expect(record.pool).toBe(pool.counter === "runningBackground" ? "background" : pool.counter === "runningForeground" ? "foreground" : undefined);
        expect(slots(manager).runningBackground).toBe(pool.counter === "runningBackground" ? 1 : 0);
        expect(slots(manager).runningForeground).toBe(pool.counter === "runningForeground" ? 1 : 0);
      });

      it("settles a completed resume", async () => {
        const { record, finish } = await start();
        resumes[0].resolve({ text: "second" });
        await finish();
        expect(record.status).toBe("completed");
        expect(record.result).toBe("second");
        expect(record.completedAt).toBeDefined();
        expect(record.resultConsumed).toBe(pool.options === undefined);
        expectSettledOnce("completed");
      });

      it("settles a failure reported by the runner", async () => {
        const { record, finish } = await start();
        resumes[0].resolve({ text: "partial", failure: "model failed" });
        await finish();
        expect(record.error).toBe("model failed");
        expect(record.result).toBe("partial");
        expectSettledOnce("error");
      });

      it("settles a rejected resume", async () => {
        const { record, finish } = await start();
        resumes[0].reject(new Error("boom"));
        await finish();
        expect(record.error).toBe("boom");
        expectSettledOnce("error");
      });

      it("stops the resume's own run and keeps stopped when it then resolves", async () => {
        const { id, record, finish } = await start();
        expect(manager.abort(id, "user")).toBe(true);
        expect(resumes[0].signal?.aborted).toBe(true);
        resumes[0].resolve({ text: "late" });
        await finish();
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
      });

      it("keeps stopped when a stopped resume rejects", async () => {
        const { id, record, finish } = await start();
        manager.abort(id, "user");
        resumes[0].reject(new Error("aborted"));
        await finish();
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
      });

      it("settles a wedged resume through the forced settle", async () => {
        const { id, record } = await start();
        manager.abort(id, "user");
        expect(completed).toEqual([]);
        await vi.advanceTimersByTimeAsync(GRACE);
        expectSettledOnce("stopped");
        expect(record.settled).toBe(true);
      });

      it("does not settle again when a forced resume resolves late", async () => {
        const { id, record, finish } = await start();
        manager.abort(id, "user");
        await vi.advanceTimersByTimeAsync(GRACE);
        resumes[0].resolve({ text: "late" });
        await finish();
        expect(record.status).toBe("stopped");
        expectSettledOnce("stopped");
      });

      it("ignores the late ending of a forced resume once the record runs again", async () => {
        const { id, record } = await start();
        manager.abort(id, "user");
        await vi.advanceTimersByTimeAsync(GRACE);
        completed.length = 0;
        const second = manager.resume(id, "third", undefined, pool.options);
        resumes[0].resolve({ text: "stale" });
        await vi.advanceTimersByTimeAsync(0);
        expect(record.status).toBe("running");
        expect(completed).toEqual([]);
        resumes[1].resolve({ text: "fresh" });
        await second;
        await record.promise;
        expect(record.result).toBe("fresh");
        expectSettledOnce("completed");
      });

      it("flushes the output file once", async () => {
        const { id, record, finish } = await start();
        const flush = vi.fn();
        record.outputCleanup = flush;
        manager.abort(id, "user");
        await vi.advanceTimersByTimeAsync(GRACE);
        resumes[0].resolve({ text: "late" });
        await finish();
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
        const { id, record } = await spawnSettled();
        const pending = manager.resume(id, "again", undefined, pool.options);
        childId = manager.spawn(mockPi, mockCtx, "Y", "c", {
          description: "d",
          parentAgentId: id,
          isBackground: true,
        });
        resumes[0].resolve({ text: "second" });
        await pending;
        await record.promise;
        expect(childStatusAtCallback).toBe("stopped");
      });

      it("stops the resume when the parent signal aborts and detaches it on settle", async () => {
        manager = new AgentManager(record => completed.push(record), 1);
        pool.setup(manager);
        const { id, record } = await spawnSettled();
        const controller = new AbortController();
        const detach = vi.spyOn(controller.signal, "removeEventListener");
        const pending = manager.resume(id, "again", controller.signal, { ...pool.options, signalCause: "owner" });
        controller.abort();
        expect(record.status).toBe("stopped");
        expect(resumes[0].signal?.aborted).toBe(true);
        resumes[0].resolve({ text: "late" });
        await pending;
        await record.promise;
        expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
        expectSettledOnce("stopped");
      });
    });
  }

  describe("queue", () => {
    it("queues a background resume with a start gate and starts it when a slot frees", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const { id, record } = await spawnSettled();
      const holder = manager.spawn(mockPi, mockCtx, "X", "h", { description: "d", isBackground: true });
      await manager.resume(id, "again", undefined, { isBackground: true });
      expect(record.status).toBe("queued");
      expect(record.startGate).toBeDefined();
      expect(slots(manager).runningBackground).toBe(1);
      runs[runs.length - 1].resolve(result());
      await manager.getRecord(holder)?.promise;
      expect(record.status).toBe("running");
      expect(record.startGate).toBeUndefined();
      expect(slots(manager).runningBackground).toBe(1);
      resumes[0].resolve({ text: "second" });
      await record.promise;
      expect(slots(manager).runningBackground).toBe(0);
    });

    it("queues a foreground resume behind a full foreground pool", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      manager.setMaxConcurrentForeground(1);
      const { id, record } = await spawnSettled();
      const holder = manager.spawn(mockPi, mockCtx, "X", "h", { description: "d", isBackground: false, blocking: true });
      expect(slots(manager).runningForeground).toBe(1);
      const pending = manager.resume(id, "again");
      expect(record.status).toBe("queued");
      expect(record.startGate).toBeDefined();
      expect(resumes).toHaveLength(0);
      runs[runs.length - 1].resolve(result());
      await manager.getRecord(holder)?.promise;
      expect(record.status).toBe("running");
      expect(slots(manager).runningForeground).toBe(1);
      resumes[0].resolve({ text: "second" });
      expect(await pending).toBe(record);
      expect(record.result).toBe("second");
      expect(slots(manager).runningForeground).toBe(0);
    });

    it("returns a foreground resume that is stopped while queued", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      manager.setMaxConcurrentForeground(1);
      const { id, record } = await spawnSettled();
      manager.spawn(mockPi, mockCtx, "X", "h", { description: "d", isBackground: false, blocking: true });
      const pending = manager.resume(id, "again");
      expect(manager.abort(id, "user")).toBe(true);
      expect(await pending).toBe(record);
      expect(record.status).toBe("stopped");
      expect(resumes).toHaveLength(0);
      expect(slots(manager).runningForeground).toBe(1);
    });
  });

  describe("a once-background record", () => {
    for (const foregroundMax of [0, 1]) {
      it(`stops a foreground resume and keeps the slot counts right (maxConcurrentForeground ${foregroundMax})`, async () => {
        manager = new AgentManager(record => completed.push(record), 2);
        manager.setMaxConcurrentForeground(foregroundMax);
        const { id, record } = await spawnSettled({ isBackground: true });
        expect(record.isBackground).toBe(true);
        manager.spawn(mockPi, mockCtx, "X", "other", { description: "d", isBackground: true });
        expect(slots(manager).runningBackground).toBe(1);

        const pending = manager.resume(id, "again");
        expect(record.isBackground).toBe(false);
        expect(record.blocking).toBe(true);
        expect(slots(manager).runningBackground).toBe(1);
        expect(slots(manager).runningForeground).toBe(foregroundMax);

        manager.abort(id, "user");
        expect(resumes[0].signal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(GRACE);
        expect(completed.map(r => r.id)).toEqual([id]);
        expect(record.status).toBe("stopped");
        expect(record.resultConsumed).toBe(true);
        expect(slots(manager).runningBackground).toBe(1);
        expect(slots(manager).runningForeground).toBe(0);

        resumes[0].resolve({ text: "late" });
        expect(await pending).toBe(record);
        expect(completed).toHaveLength(1);
        expect(slots(manager).runningBackground).toBe(1);
      });
    }

    it("notifies as background again when resumed in the background", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const { id, record } = await spawnSettled();
      await manager.resume(id, "again", undefined, { isBackground: true });
      expect(record.isBackground).toBe(true);
      expect(record.blocking).toBe(false);
      resumes[0].resolve({ text: "second" });
      await record.promise;
      expect(record.resultConsumed).toBeFalsy();
      expectCompleted(completed, ["completed"]);
    });
  });

  describe("nested resume", () => {
    it("takes no pool slot and settles once", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      manager.setMaxConcurrentForeground(1);
      const parentId = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      const childId = manager.spawn(mockPi, mockCtx, "Y", "c", {
        description: "d",
        parentAgentId: parentId,
        isBackground: false,
        blocking: true,
      });
      const child = manager.getRecord(childId)!;
      runs[1].resolve(result());
      await child.promise;
      completed.length = 0;
      const pending = manager.resume(childId, "again");
      expect(child.pool).toBeUndefined();
      expect(slots(manager).runningForeground).toBe(0);
      resumes[0].resolve({ text: "second" });
      await pending;
      expectCompleted(completed, ["completed"]);
      expect(slots(manager).runningBackground).toBe(1);
    });
  });

  it("refuses a resume of a running record", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    const { id } = await spawnSettled();
    void manager.resume(id, "again");
    expect(await manager.resume(id, "twice")).toBeUndefined();
    expect(resumes).toHaveLength(1);
  });

  describe("a stopped run whose forced settle is pending", () => {
    function spawnStopped() {
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      record.session = mockSession();
      manager.abort(id, "user");
      return { id, record };
    }

    it("ignores the stale forced-settle timer after the run settled and was resumed", async () => {
      const { id, record } = spawnStopped();
      runs[0].resolve(result());
      await record.promise;
      expect(record.settled).toBe(true);
      expect(slots(manager).runningBackground).toBe(0);
      completed.length = 0;

      const second = manager.resume(id, "again", undefined, { isBackground: true });
      await vi.advanceTimersByTimeAsync(GRACE);
      expect(record.status).toBe("running");
      expect(record.settled).toBe(false);
      expect(slots(manager).runningBackground).toBe(1);
      expect(completed).toEqual([]);

      resumes[0].resolve({ text: "second" });
      await second;
      await record.promise;
      expect(record.status).toBe("completed");
      expectCompleted(completed, ["completed"]);
      expect(slots(manager).runningBackground).toBe(0);
    });

    it("refuses a resume before the forced settle and accepts it after", async () => {
      const { id, record } = spawnStopped();
      expect(record.status).toBe("stopped");
      expect(record.settled).toBeFalsy();
      expect(slots(manager).runningBackground).toBe(1);

      expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();
      expect(resumes).toHaveLength(0);
      expect(slots(manager).runningBackground).toBe(1);

      await vi.advanceTimersByTimeAsync(GRACE);
      expect(record.settled).toBe(true);
      expect(slots(manager).runningBackground).toBe(0);
      completed.length = 0;

      expect(await manager.resume(id, "late", undefined, { isBackground: true })).toBe(record);
      expect(resumes).toHaveLength(1);
      expect(slots(manager).runningBackground).toBe(1);
      resumes[0].resolve({ text: "second" });
      await record.promise;
      expect(record.status).toBe("completed");
      expectCompleted(completed, ["completed"]);
      expect(slots(manager).runningBackground).toBe(0);
    });

    it("refuses a resume of a finished run before its tail runs", async () => {
      manager = new AgentManager(record => completed.push(record), 1);
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      record.session = mockSession();
      record.status = "completed";
      expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();
      expect(resumes).toHaveLength(0);
      expect(slots(manager).runningBackground).toBe(1);
    });
  });

  it("accepts a resume of a record stopped while queued that never settled", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    const { id, record } = await spawnSettled();
    const holder = manager.spawn(mockPi, mockCtx, "X", "h", { description: "d", isBackground: true });
    await manager.resume(id, "again", undefined, { isBackground: true });
    expect(record.status).toBe("queued");
    expect(manager.abort(id, "user")).toBe(true);
    record.settled = false;
    expect(record.status).toBe("stopped");
    expect(record.promise).toBeUndefined();
    runs[runs.length - 1].resolve(result());
    await manager.getRecord(holder)?.promise;
    expect(slots(manager).runningBackground).toBe(0);

    expect(await manager.resume(id, "third", undefined, { isBackground: true })).toBe(record);
    expect(record.status).toBe("running");
    expect(slots(manager).runningBackground).toBe(1);
    resumes[0].resolve({ text: "fresh" });
    await record.promise;
    expect(record.result).toBe("fresh");
    expect(slots(manager).runningBackground).toBe(0);
  });

  it("refuses a resume of a run that is still in flight and unsettled", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id, "user");
    expect(record.settled).toBeFalsy();
    expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();
    expect(resumes).toHaveLength(0);
  });

  it("refuses a resume while the worktree of a forced-settled run is unsaved", async () => {
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(record.settled).toBe(true);

    expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();
    expect(resumes).toHaveLength(0);
    expect(slots(manager).runningBackground).toBe(0);

    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, path: "/tmp/wt", removalFailure: "busy" } as any);
    runs[0].resolve(result());
    await record.promise;
    expect(record.worktreeResult).toBeDefined();
    expect(await manager.resume(id, "after", undefined, { isBackground: true })).toBe(record);
    expect(resumes).toHaveLength(1);
    expect(slots(manager).runningBackground).toBe(1);
  });

  it("refuses a resume after the worktree was removed and keeps the prior result", async () => {
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "saved-branch", path: "/tmp/wt" } as any);
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    runs[0].resolve(result());
    await record.promise;
    vi.mocked(isWorktreeRetained).mockReturnValue(false);
    const priorResult = record.result;
    const priorWorktreeResult = record.worktreeResult;

    expect(await manager.resume(id, "again", undefined, { isBackground: true })).toBeUndefined();
    expect(resumes).toHaveLength(0);
    expect(slots(manager).runningBackground).toBe(0);
    expect(record.result).toBe(priorResult);
    expect(record.worktreeResult).toBe(priorWorktreeResult);
    expect(record.status).toBe("completed");
  });

  it("accepts a resume after a worktree save that throws", async () => {
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    vi.mocked(cleanupWorktree).mockRejectedValue(new Error("disk gone"));
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(await manager.resume(id, "early", undefined, { isBackground: true })).toBeUndefined();

    runs[0].resolve(result());
    await record.promise;
    expect(record.worktreeResult).toMatchObject({ hasChanges: true, path: "/tmp/wt", failure: "disk gone" });
    expect(record.result).toContain("disk gone");
    expect(await manager.resume(id, "after", undefined, { isBackground: true })).toBe(record);
    expect(resumes).toHaveLength(1);
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReturnValue({ hasChanges: false } as any);
  });

  async function resumeRetained() {
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" } as any);
    vi.mocked(cleanupWorktree).mockResolvedValueOnce({ hasChanges: true, path: "/tmp/wt", removalFailure: "busy" } as any);
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    runs[0].resolve(result());
    await record.promise;
    completed.length = 0;
    return { id, record };
  }

  it("cleans up the worktree when a resumed run completes", async () => {
    const { id, record } = await resumeRetained();
    vi.mocked(cleanupWorktree).mockResolvedValueOnce({ hasChanges: true, branch: "again-branch", path: "/tmp/wt" } as any);
    const pending = manager.resume(id, "again", undefined, { isBackground: true });
    resumes[0].resolve({ text: "second" });
    await pending;
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(record.result).toContain("Changes saved to branch `again-branch`");
    expect(record.worktreeResult?.branch).toBe("again-branch");
    expect(record.status).toBe("completed");
    expectCompleted(completed, ["completed"]);
    expect(await manager.resume(id, "third", undefined, { isBackground: true })).toBe(record);
  });

  it("cleans up the worktree when a resumed run fails", async () => {
    const { id, record } = await resumeRetained();
    vi.mocked(cleanupWorktree).mockResolvedValueOnce({ hasChanges: true, path: "/tmp/wt", failure: "disk gone" } as any);
    const pending = manager.resume(id, "again", undefined, { isBackground: true });
    resumes[0].reject(new Error("boom"));
    await pending;
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(record.worktreeResult).toMatchObject({ hasChanges: true, path: "/tmp/wt", failure: "disk gone" });
    expect(record.result).toContain("disk gone");
    expect(record.status).toBe("error");
    expectCompleted(completed, ["error"]);
  });

  it("cleans up the worktree when a stopped resumed run ends", async () => {
    const { id, record } = await resumeRetained();
    vi.mocked(cleanupWorktree).mockResolvedValueOnce({ hasChanges: true, branch: "stopped-branch", path: "/tmp/wt" } as any);
    const pending = manager.resume(id, "again", undefined, { isBackground: true });
    expect(manager.abort(id, "user")).toBe(true);
    resumes[0].resolve({ text: "late" });
    await pending;
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(record.status).toBe("stopped");
    expect(record.result).toContain("stopped-branch");
    expectCompleted(completed, ["stopped"]);
  });

  it("refuses a further resume once the resumed cleanup removes the worktree path", async () => {
    const { id, record } = await resumeRetained();
    vi.mocked(cleanupWorktree).mockResolvedValueOnce({ hasChanges: false } as any);
    const pending = manager.resume(id, "again", undefined, { isBackground: true });
    resumes[0].resolve({ text: "second" });
    await pending;
    await record.promise;
    vi.mocked(isWorktreeRetained).mockReturnValue(false);
    const priorResult = record.result;

    expect(await manager.resume(id, "third", undefined, { isBackground: true })).toBeUndefined();
    expect(resumes).toHaveLength(1);
    expect(record.result).toBe(priorResult);
  });

  it("ignores the late result of a forced spawn once the record is resumed", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expectCompleted(completed, ["stopped"]);
    expect(slots(manager).runningBackground).toBe(0);

    await manager.resume(id, "again", undefined, { isBackground: true });
    expect(slots(manager).runningBackground).toBe(1);
    const completedAt = record.completedAt;
    runs[0].resolve(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    expect(record.completedAt).toBe(completedAt);
    expect(slots(manager).runningBackground).toBe(1);
    expect(completed).toHaveLength(1);

    resumes[0].resolve({ text: "fresh" });
    await record.promise;
    expect(record.result).toBe("fresh");
    expect(record.status).toBe("completed");
    expect(completed).toHaveLength(2);
    expect(slots(manager).runningBackground).toBe(0);
  });

  it("ignores the late rejection of a forced spawn once the record is resumed", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = mockSession();
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    await manager.resume(id, "again", undefined, { isBackground: true });
    runs[0].reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(record.status).toBe("running");
    expect(record.error).toBeUndefined();
    expect(slots(manager).runningBackground).toBe(1);

    resumes[0].resolve({ text: "fresh" });
    await record.promise;
    expect(record.status).toBe("completed");
    expect(completed).toHaveLength(2);
    expect(slots(manager).runningBackground).toBe(0);
  });

  it("settles a resume stopped while queued and accepts a later resume", async () => {
    manager = new AgentManager(record => completed.push(record), 1);
    manager.setMaxConcurrentForeground(1);
    const { id, record } = await spawnSettled();
    const holder = manager.spawn(mockPi, mockCtx, "X", "h", { description: "d", isBackground: false, blocking: true });
    const pending = manager.resume(id, "again");
    manager.abort(id, "user");
    await pending;
    expect(record.settled).toBe(true);
    expectCompleted(completed, ["stopped"]);
    expect(slots(manager).runningForeground).toBe(1);

    runs[runs.length - 1].resolve(result());
    await manager.getRecord(holder)?.promise;
    expect(slots(manager).runningForeground).toBe(0);
    const second = manager.resume(id, "third");
    expect(record.status).toBe("running");
    resumes[0].resolve({ text: "fresh" });
    expect(await second).toBe(record);
    expect(record.result).toBe("fresh");
    expect(slots(manager).runningForeground).toBe(0);
  });
});

describe("AgentManager — start endings settle once", () => {
  const worktree = { path: "/tmp/wt", branch: "b", baseSha: "abc", workPath: "/tmp/wt" };
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
    vi.mocked(isWorktreeRetained).mockReturnValue(true);
  });

  for (const pool of POOLS) {
    describe(pool.name, () => {
      function create() {
        manager = new AgentManager(record => completed.push(record), 1);
        pool.setup(manager);
      }

      function spawn(extra: { signal?: AbortSignal; signalCause?: StopCause; isolation?: "worktree"; cwd?: string } = {}) {
        const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", ...pool.options, ...extra });
        return { id, record: manager.getRecord(id)! };
      }

      function held(): number {
        return pool.counter === undefined ? 0 : slots(manager)[pool.counter];
      }

      function expectNoSlots() {
        expect(slots(manager).runningBackground).toBe(0);
        expect(slots(manager).runningForeground).toBe(0);
      }

      function expectNotConsumedUnlessForeground(record: AgentRecord) {
        expect(Boolean(record.resultConsumed)).toBe(!pool.options.isBackground);
      }

      it("settles a start that cannot create its worktree, rethrows, and drops the record", async () => {
        create();
        vi.mocked(createWorktree).mockResolvedValue(undefined);
        const { id, record } = spawn({ isolation: "worktree" });
        await expect(manager.awaitStartup(id)).rejects.toThrow(/isolation: "worktree"/);
        expect(record.status).toBe("error");
        expect(record.error).toContain('isolation: "worktree"');
        expect(record.completedAt).toBeDefined();
        expect(completed).toEqual([record]);
        expect(manager.getRecord(id)).toBeUndefined();
        expect(record.resultConsumed).toBe(true);
        expectNoSlots();
        expect(runs).toHaveLength(0);
      });

      it("settles a start whose worktree creation throws", async () => {
        create();
        vi.mocked(createWorktree).mockRejectedValue(new Error("git exploded"));
        const { id, record } = spawn({ isolation: "worktree" });
        await expect(manager.awaitStartup(id)).rejects.toThrow("git exploded");
        expect(record.status).toBe("error");
        expect(record.error).toBe("git exploded");
        expect(manager.getRecord(id)).toBeUndefined();
        expect(completed).toEqual([record]);
        expect(record.resultConsumed).toBe(true);
        expectNoSlots();
        expect(runs).toHaveLength(0);
      });

      it("settles a stop during worktree creation once and removes the worktree", async () => {
        create();
        let finish!: (value: unknown) => void;
        vi.mocked(createWorktree).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as any);
        const { id, record } = spawn({ isolation: "worktree" });
        expect(held()).toBe(pool.counter === undefined ? 0 : 1);
        expect(manager.abort(id, "user")).toBe(true);
        expect(completed).toEqual([]);
        finish(worktree);
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanupWorktree).toHaveBeenCalledTimes(1);
        expect(record.status).toBe("stopped");
        expect(record.settled).toBe(true);
        expect(completed).toEqual([record]);
        expectNoSlots();
        expect(runs).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(GRACE);
        expect(completed).toEqual([record]);
        expectNoSlots();
      });

      if (pool.counter !== undefined) {
        function holdThePool() {
          create();
          return spawn();
        }

        it("settles a stop while queued once", async () => {
          const holder = holdThePool();
          const { id, record } = spawn();
          expect(record.status).toBe("queued");
          expect(manager.abort(id, "user")).toBe(true);
          expect(record.status).toBe("stopped");
          expect(completed).toEqual([record]);
          expect(held()).toBe(1);
          runs[0].resolve(result());
          await holder.record.promise;
          expect(completed.map(r => r.status)).toEqual(["stopped", "completed"]);
          expect(runs).toHaveLength(1);
          expectNoSlots();
        });

        it("settles a signal that is already aborted at spawn once", async () => {
          const holder = holdThePool();
          const { record } = spawn({ signal: AbortSignal.abort(), signalCause: "extension" });
          expect(record.status).toBe("stopped");
          expect(record.completedAt).toBeDefined();
          expect(record.settled).toBe(true);
          expect(completed).toEqual([record]);
          expectNotConsumedUnlessForeground(record);
          expect(held()).toBe(1);
          runs[0].resolve(result());
          await holder.record.promise;
          expect(completed.map(r => r.status)).toEqual(["stopped", "completed"]);
          expect(runs).toHaveLength(1);
          expectNoSlots();
        });

        it("settles a queued start that fails at the worktree", async () => {
          const holder = holdThePool();
          vi.mocked(createWorktree).mockResolvedValue(undefined);
          const { record } = spawn({ isolation: "worktree" });
          expect(record.status).toBe("queued");
          runs[0].resolve(result());
          await holder.record.promise;
          await vi.advanceTimersByTimeAsync(0);
          expect(record.status).toBe("error");
          expect(record.error).toContain('isolation: "worktree"');
          expect(manager.getRecord(record.id)).toBe(record);
          expect(completed.map(r => r.status)).toEqual(["completed", "error"]);
          expectNotConsumedUnlessForeground(record);
          expectNoSlots();
          expect(runs).toHaveLength(1);
        });

        it("settles a queued start that fails before it takes a slot", async () => {
          const holder = holdThePool();
          const gone = mkdtempSync(join(tmpdir(), "lifecycle-gone-"));
          const { record } = spawn({ cwd: gone });
          expect(record.status).toBe("queued");
          rmSync(gone, { recursive: true, force: true });
          runs[0].resolve(result());
          await holder.record.promise;
          await vi.advanceTimersByTimeAsync(0);
          expect(record.status).toBe("error");
          expect(record.error).toContain(gone);
          expect(record.pool).toBeUndefined();
          expect(completed.map(r => r.status)).toEqual(["completed", "error"]);
          expectNoSlots();
          expect(runs).toHaveLength(1);
        });
      }
    });
  }
});

function expectCompleted(completed: AgentRecord[], statuses: AgentRecord["status"][]) {
  expect(completed.map(r => r.status)).toEqual(statuses);
}
