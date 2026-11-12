import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { GrantingAgentManager as AgentManager } from "./helpers/capability.js";

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

import { isWorktreeIsolationEnabled } from "../src/platform/worktree.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";
import { addUsage } from "../src/usage.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    await record.promise;
    record.resultConsumed = true;

    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — spawnAndWait onSpawned + foreground output file wiring (#105)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("fields set on the record in onSpawned are visible when onSessionCreated fires", async () => {
    manager = new AgentManager();
    let capturedId: string | undefined;
    let outputFileSeenAtSessionCreated: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      outputFileSeenAtSessionCreated = capturedId
        ? manager.getRecord(capturedId)?.outputFile
        : undefined;
      return { responseText: "done", session, aborted: false, steered: false };
    });

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => {
      capturedId = fgId;
      manager.getRecord(fgId)!.outputFile = "/fake/agent.jsonl";
    });

    expect(outputFileSeenAtSessionCreated).toBe("/fake/agent.jsonl");
  });

  it("onSpawned id matches the id returned by spawnAndWait", async () => {
    manager = new AgentManager();
    let spawnedId: string | undefined;
    resolvedRun();

    const { id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => { spawnedId = fgId; });

    expect(spawnedId).toBe(id);
  });

  it("restores the shared onSpawned callback before awaiting the foreground run", async () => {
    manager = new AgentManager();
    let finishFirst: ((value: any) => void) | undefined;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({
        responseText: "second",
        session: mockSession(),
        aborted: false,
        steered: false,
      });
    const firstCallback = vi.fn();

    const first = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
    }, firstCallback);
    const secondId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });

    expect(firstCallback).toHaveBeenCalledTimes(1);
    await manager.getRecord(secondId)!.promise;
    finishFirst?.({
      responseText: "first",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    await first;
  });

  it("onComplete fires on the error path with resultConsumed=true", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => { completedRecord = r; });
    vi.mocked(runAgent).mockRejectedValue(new Error("agent failed"));

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("error");
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — nested runtime propagation", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("stores nesting metadata and passes the owning manager/runtime to runAgent", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "scout", "nested", {
      description: "nested",
      isBackground: true,
      depth: 2,
      parentAgentId: "parent-1",
      maxSubagentDepth: 3,
      configCwd: "/trusted/config",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      depth: 2,
      parentAgentId: "parent-1",
      maxSubagentDepth: 3,
    }));
    expect(runAgent).toHaveBeenLastCalledWith(
      mockCtx,
      "scout",
      "nested",
      expect.objectContaining({
        configCwd: "/trusted/config",
        nestedRuntime: {
          manager,
          parentAgentId: id,
          depth: 2,
          maxSubagentDepth: 3,
        },
      }),
    );
  });

  it("tells the runner which spawns are nested, so only top-level ones persist", async () => {
    resolvedRun();
    manager = new AgentManager();
    const child = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child", isBackground: true, depth: 2, parentAgentId: "parent-1",
    });
    await manager.getRecord(child)!.promise;
    expect(runAgent).toHaveBeenLastCalledWith(
      mockCtx, "scout", "child", expect.objectContaining({ nested: true }),
    );

    const top = manager.spawn(mockPi, mockCtx, "scout", "top", { description: "top", isBackground: true });
    await manager.getRecord(top)!.promise;
    expect(runAgent).toHaveBeenLastCalledWith(
      mockCtx, "scout", "top", expect.objectContaining({ nested: false }),
    );
  });

  it("defaults top-level subagents to depth one", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "scout", "top", {
      description: "top",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)?.depth).toBe(1);
    expect(vi.mocked(runAgent).mock.lastCall?.[3].nestedRuntime).toEqual(expect.objectContaining({
      parentAgentId: id,
      depth: 1,
    }));
  });

  it("starts a nested background child even when the concurrency pool is full", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling",
      isBackground: true,
    });

    expect(manager.getRecord(childId)?.status).toBe("running");
    expect(manager.getRecord(siblingId)?.status).toBe("queued");
  });

  it("aborts owned children when the parent settles", async () => {
    let finishParent: ((value: any) => void) | undefined;
    const abortable = (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ responseText: "", session: mockSession(), aborted: true, steered: false }),
        );
      });
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishParent = resolve; }))
      .mockImplementation(abortable as any);
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const runningChild = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    const grandchild = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      depth: 3,
      parentAgentId: runningChild,
    });

    finishParent?.({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(parentId)!.promise;

    expect(manager.getRecord(runningChild)?.status).toBe("stopped");
    await manager.getRecord(runningChild)!.promise;
    expect(manager.getRecord(grandchild)?.status).toBe("stopped");
  });

  it("aborts children spawned during a resumed turn", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    await manager.getRecord(parentId)!.promise;

    let childId = "";
    vi.mocked(resumeAgent).mockImplementation(async () => {
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
      childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
        description: "child",
        isBackground: true,
        depth: 2,
        parentAgentId: parentId,
      });
      return { text: "resumed" } as any;
    });

    await manager.resume(parentId, "keep going");

    expect(manager.getRecord(childId)?.status).toBe("stopped");
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    manager = new AgentManager(undefined, 1);

    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}),
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

describe("AgentManager — the usage hook fires once per assistant message", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("fires once per message, with the same delta the record accumulates", async () => {
    const seen: any[] = [];
    manager = new AgentManager(undefined, undefined, undefined, undefined, (r, u) => seen.push({ id: r.id, u }));
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20, cost: 0.02 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(seen.map(s => s.u)).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cost: 0.01 },
      { input: 200, output: 80, cacheWrite: 20, cost: 0.02 },
    ]);
    expect(seen.every(s => s.id === id)).toBe(true);
  });

  it("fires once for a nested child, even though its spend is booked to ancestors too", async () => {
    const seen: any[] = [];
    manager = new AgentManager(undefined, undefined, undefined, undefined, (_r, u) => seen.push(u));
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0, cost: 0.001 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    await manager.getRecord(parentId)!.promise;
    seen.length = 0;

    const childId = manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: parentId,
      onAssistantUsage: (u: any) => { addUsage(manager.getRecord(parentId)!.lifetimeUsage, u); },
    } as any);
    await manager.getRecord(childId)!.promise;

    expect(seen).toEqual([{ input: 10, output: 5, cacheWrite: 0, cost: 0.001 }]);
    expect(manager.getRecord(parentId)!.lifetimeUsage).toEqual({ input: 20, output: 10, cacheWrite: 0, cost: 0.002 });
  });
});

describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cost: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20, cost: 0.02 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30, cost: 0.03,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cost: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    const { resumeAgent: resumeMock } = await import("../src/session/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5, cost: 0.007 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5, cost: 0.007 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("awaitStartup rejects when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await expect(manager.awaitStartup(id)).rejects.toThrow(/isolation: "worktree"/);

    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("a foreground spawn surfaces the same failure by rejecting spawnAndWait", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    await expect(manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).rejects.toThrow(/isolation: "worktree"/);

    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps the concurrency slot accounting straight while the worktree is being created", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    let releaseCopy!: () => void;
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCopy = () => resolve(undefined); }),
    );
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager(undefined, 1);
    const slowId = manager.spawn(mockPi, mockCtx, "X", "slow", {
      description: "slow", isBackground: true, isolation: "worktree",
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "queued", {
      description: "queued", isBackground: true,
    });

    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    expect(runAgent).not.toHaveBeenCalled();

    releaseCopy();
    await expect(manager.awaitStartup(slowId)).rejects.toThrow(/isolation: "worktree"/);
    await manager.getRecord(queuedId)!.promise;

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(queuedId)!.status).toBe("completed");
  });

  it("a stop that lands during the copy discards the worktree instead of running", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/platform/worktree.js");
    let releaseCopy!: () => void;
    const wt = { path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy" };
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCopy = () => resolve(wt); }),
    );
    vi.mocked(cleanupWorktree).mockClear();
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "stopped", {
      description: "stopped", isBackground: true, isolation: "worktree",
    });
    expect(manager.abort(id)).toBe(true);

    releaseCopy();
    await manager.awaitStartup(id);

    expect(runAgent).not.toHaveBeenCalled();
    expect(cleanupWorktree).toHaveBeenCalledWith(mockPi, "/tmp", wt, "stopped");
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });
});

describe("AgentManager — worktreeIsolation: false refuses worktrees", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  });

  it("creates no worktree for an RPC-shaped spawn when the project disabled it", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockClear();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });

    expect(createWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.worktree).toBeUndefined();
  });

  it("does not mask a genuine worktree failure while enabled", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await expect(manager.awaitStartup(id)).rejects.toThrow(/isolation: "worktree"/);
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith(mockPi, "/", id);
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp", worktreeBase: "/" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith(mockPi, "/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
    expect(opts.worktreeBase).toBe("/tmp");
  });

  it("no worktree — no worktreeBase, so no isolation block in the prompt", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
    await manager.getRecord(id)!.promise;

    expect(vi.mocked(runAgent).mock.lastCall![3].worktreeBase).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url),
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.result).toBe("partial output");
  });
});

describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = undefined;

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: false });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    record.status = "stopped";
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/session/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe("");
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/session/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress");
  });
});

describe("AgentManager — pool slot accounting on settle", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  function controllableRuns() {
    const resolvers = new Map<string, (v: any) => void>();
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        resolvers.set(prompt as string, () => resolve({
          responseText: "done",
          session: mockSession(),
          aborted: false,
          steered: false,
        }));
      }),
    );
    return resolvers;
  }

  it("a nested child settling does not free a pool slot it never held", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent", isBackground: true,
    });
    manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child", isBackground: true, depth: 2, parentAgentId: parentId,
    });
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling", isBackground: true,
    });
    expect(manager.getRecord(siblingId)?.status).toBe("queued");

    resolvers.get("child")!(undefined);
    await manager.getRecord(manager.listAgents().find(a => a.description === "child")!.id)?.promise;

    expect(manager.getRecord(siblingId)?.status).toBe("queued");
  });

  it("a nested child failing does not free a pool slot either", async () => {
    const rejectors = new Map<string, (e: any) => void>();
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>((_resolve, reject) => {
        rejectors.set(prompt as string, reject);
      }),
    );
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent", isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child", isBackground: true, depth: 2, parentAgentId: parentId,
    });
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling", isBackground: true,
    });

    rejectors.get("child")!(new Error("child blew up"));
    await manager.getRecord(childId)?.promise;

    expect(manager.getRecord(childId)?.status).toBe("error");
    expect(manager.getRecord(siblingId)?.status).toBe("queued");
  });

  it("a top-level agent settling DOES free its slot", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent", isBackground: true,
    });
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling", isBackground: true,
    });
    expect(manager.getRecord(siblingId)?.status).toBe("queued");

    resolvers.get("parent")!(undefined);
    await manager.getRecord(parentId)?.promise;

    expect(manager.getRecord(siblingId)?.status).toBe("running");
  });
});

describe("AgentManager — drainQueue failure handling", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("a spawn that throws at drain time errors that record and keeps draining", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    const completed: AgentRecord[] = [];
    manager = new AgentManager(r => { completed.push(r); }, 1);

    let blocker: ((v: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        if (prompt === "first") blocker = () => resolve({
          responseText: "ok", session: mockSession(), aborted: false, steered: false,
        });
      }),
    );
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);

    const firstId = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first", isBackground: true });
    const boomId = manager.spawn(mockPi, mockCtx, "X", "boom", {
      description: "boom", isBackground: true, isolation: "worktree",
    });
    const lastId = manager.spawn(mockPi, mockCtx, "X", "last", { description: "last", isBackground: true });
    expect(manager.getRecord(boomId)?.status).toBe("queued");

    blocker!(undefined);
    await manager.getRecord(firstId)?.promise;

    const boom = manager.getRecord(boomId)!;
    expect(boom.status).toBe("error");
    expect(boom.error).toContain('isolation: "worktree"');
    expect(boom.completedAt).toBeGreaterThan(0);
    expect(completed.map(r => r.id)).toContain(boomId);
    expect(manager.getRecord(lastId)?.status).toBe("running");
  });

  it("a cwd deleted between enqueue and drain is caught by the re-validation", async () => {
    manager = new AgentManager(undefined, 1);

    let blocker: ((v: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        if (prompt === "first") blocker = () => resolve({
          responseText: "ok", session: mockSession(), aborted: false, steered: false,
        });
      }),
    );

    const firstId = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first", isBackground: true });
    const goneDir = mkdtempSync(join(tmpdir(), "pi-mgr-gone-"));
    const goneId = manager.spawn(mockPi, mockCtx, "X", "gone", {
      description: "gone", isBackground: true, cwd: goneDir,
    });
    expect(manager.getRecord(goneId)?.status).toBe("queued");

    rmSync(goneDir, { recursive: true, force: true });

    blocker!(undefined);
    await manager.getRecord(firstId)?.promise;

    const gone = manager.getRecord(goneId)!;
    expect(gone.status).toBe("error");
    expect(gone.error).toContain(goneDir);
  });

  it("raising maxConcurrent releases queued agents immediately", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);

    manager.spawn(mockPi, mockCtx, "X", "a", { description: "a", isBackground: true });
    const bId = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(bId)?.status).toBe("queued");

    manager.setMaxConcurrent(2);
    expect(manager.getRecord(bId)?.status).toBe("running");
  });

  it("setMaxConcurrent clamps to at least 1", () => {
    manager = new AgentManager(undefined, 4);
    manager.setMaxConcurrent(0);
    expect(manager.getMaxConcurrent()).toBe(1);
  });
});

describe("AgentManager — pendingSteers flush", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("delivers steers queued before the session existed, in order, then clears them", async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    let release: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        release = () => {
          opts.onSessionCreated?.({ steer, dispose: vi.fn() });
          resolve({ responseText: "ok", session: mockSession(), aborted: false, steered: false });
        };
      }),
    );

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p", isBackground: true });
    const record = manager.getRecord(id)!;

    manager.steer(id, "first correction");
    manager.steer(id, "second correction");
    expect(record.pendingSteers).toEqual(["first correction", "second correction"]);

    release!();
    await record.promise;

    expect(steer.mock.calls.map(c => c[0])).toEqual(["first correction", "second correction"]);
    expect(record.pendingSteers).toBeUndefined();
  });

  it("a steer that rejects does not fail the run", async () => {
    const steer = vi.fn().mockRejectedValue(new Error("session closed"));
    let release: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        release = () => {
          opts.onSessionCreated?.({ steer, dispose: vi.fn() });
          resolve({ responseText: "ok", session: mockSession(), aborted: false, steered: false });
        };
      }),
    );

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p", isBackground: true });
    const record = manager.getRecord(id)!;
    manager.steer(id, "hello");

    release!();
    await expect(record.promise).resolves.toBe("ok");
    expect(record.status).toBe("completed");
  });
});

describe("AgentManager — waitForAll", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("waits for agents that were still QUEUED when it was called", async () => {
    const resolvers = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        resolvers.set(prompt as string, () => resolve({
          responseText: "done", session: mockSession(), aborted: false, steered: false,
        }));
      }),
    );

    manager = new AgentManager(undefined, 1);
    const ids = ["a", "b", "c"].map(p =>
      manager.spawn(mockPi, mockCtx, "X", p, { description: p, isBackground: true }),
    );
    expect(manager.getRecord(ids[1])?.status).toBe("queued");

    let settled = false;
    const all = manager.waitForAll().then(() => { settled = true; });

    await new Promise(r => setImmediate(r));
    resolvers.get("a")!();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(settled, "waitForAll resolved while agents were still queued").toBe(false);

    for (const p of ["b", "c"]) {
      resolvers.get(p)!();
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    }
    await all;

    expect(settled).toBe(true);
    for (const id of ids) {
      expect(manager.getRecord(id)?.status, id).toBe("completed");
    }
  });

  it("resolves immediately when nothing is pending", async () => {
    manager = new AgentManager();
    await expect(manager.waitForAll()).resolves.toBeUndefined();
  });

  it("waits for an agent whose worktree is still being created", async () => {
    const { createWorktree } = await import("../src/platform/worktree.js");
    let releaseCopy!: () => void;
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => {
        releaseCopy = () => resolve({ path: "/wt/copy", branch: "b", baseSha: "abc", workPath: "/wt/copy" });
      }),
    );
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "X", "copying", {
      description: "copying", isBackground: true, isolation: "worktree",
    });

    let settled = false;
    const all = manager.waitForAll().then(() => { settled = true; });
    await new Promise(r => setImmediate(r));
    expect(settled, "waitForAll resolved while the worktree was still being created").toBe(false);
    expect(runAgent).not.toHaveBeenCalled();

    releaseCopy();
    await all;
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not reject when an agent fails", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p", isBackground: true });

    await expect(manager.waitForAll()).resolves.toBeUndefined();
    expect(manager.getRecord(id)?.status).toBe("error");
  });
});

describe("AgentManager — dispose prunes worktree repos", () => {
  it("prunes the process cwd and every repo a worktree was created from", async () => {
    const { createWorktree, pruneWorktrees } = await import("../src/platform/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "b", baseSha: "abc", workPath: "/wt/copy",
    });
    vi.mocked(pruneWorktrees).mockClear().mockResolvedValue(undefined);
    resolvedRun();

    const manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "p", cwd: "/", isolation: "worktree",
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;

    manager.dispose();
    expect(pruneWorktrees).not.toHaveBeenCalled();

    manager.dispose(mockPi);
    expect(pruneWorktrees).toHaveBeenCalledWith(mockPi, process.cwd());
    expect(pruneWorktrees).toHaveBeenCalledWith(mockPi, "/");
  });
});

describe("AgentManager — background resume", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  async function spawnSettled(mgr: AgentManager): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    const id = mgr.spawn(mockPi, mockCtx, "general-purpose", "task", {
      description: "task",
      isBackground: true,
    });
    await mgr.getRecord(id)!.promise;
    return id;
  }

  it("returns immediately with a running record + promise, then settles and fires onComplete", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    let finish!: (v: { text: string; failure?: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );

    const record = await manager.resume(id, "keep going", undefined, { isBackground: true });
    expect(record?.status).toBe("running");
    expect(record?.promise).toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();

    finish({ text: "second" });
    await record!.promise;

    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.result).toBe("second");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a failed final turn on a background resume maps to error and still notifies", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    vi.mocked(resumeAgent).mockResolvedValue({
      text: "partial",
      failure: "provider exploded",
    } as any);

    const record = await manager.resume(id, "again", undefined, { isBackground: true });
    await record!.promise;

    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.error).toBe("provider exploded");
    expect(manager.getRecord(id)!.result).toBe("partial");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("forwards activity/usage callbacks to the resumed run", async () => {
    manager = new AgentManager();
    const id = await spawnSettled(manager);

    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onToolActivity?.({ type: "end", toolName: "grep" });
      opts.onAssistantUsage?.({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
      return { text: "ok" };
    });

    const record = await manager.resume(id, "go", undefined, {
      isBackground: true,
      onToolActivity,
      onAssistantUsage,
    });
    await record!.promise;

    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: "grep" });
    expect(onAssistantUsage).toHaveBeenCalledWith({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
    expect(manager.getRecord(id)!.toolUses).toBe(1);
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
  });

  it("queues a background resume when the concurrency pool is full", async () => {
    manager = new AgentManager(undefined, 1);
    const id = await spawnSettled(manager);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const blockerId = manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
      isBackground: true,
    });
    expect(manager.getRecord(blockerId)!.status).toBe("running");

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();
    const record = await manager.resume(id, "later", undefined, { isBackground: true });

    expect(record?.status).toBe("queued");
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("foreground resume is unchanged: awaits inline and does not fire onComplete", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    vi.mocked(resumeAgent).mockResolvedValue({ text: "inline result" } as any);
    const record = await manager.resume(id, "sync");

    expect(record?.status).toBe("completed");
    expect(record?.result).toBe("inline result");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("refuses to background-resume an agent whose run is still in flight", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    const first = await manager.resume(id, "go", undefined, { isBackground: true });
    expect(first?.status).toBe("running");
    const liveController = manager.getRecord(id)!.abortController;

    const second = await manager.resume(id, "go again", undefined, { isBackground: true });

    expect(second).toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)!.abortController).toBe(liveController);
    expect(manager.getRecord(id)!.status).toBe("running");
    expect(onComplete).not.toHaveBeenCalled();
    expect(manager.abort(id)).toBe(true);
    expect(liveController!.signal.aborted).toBe(true);
  });

  it("refuses to background-resume an agent that is still queued", async () => {
    manager = new AgentManager(undefined, 1);
    const id = await spawnSettled(manager);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
      isBackground: true,
    });

    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    expect((await manager.resume(id, "later", undefined, { isBackground: true }))?.status).toBe("queued");

    expect(await manager.resume(id, "later again", undefined, { isBackground: true })).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("fires onStarted when the run starts, not when a queued resume is registered", async () => {
    manager = new AgentManager(undefined, 1);
    const id = await spawnSettled(manager);

    let releaseBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { releaseBlocker = resolve; }));
    manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
      isBackground: true,
    });

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    const onStarted = vi.fn();
    const record = await manager.resume(id, "later", undefined, { isBackground: true, onStarted });

    expect(record?.status).toBe("queued");
    expect(onStarted).not.toHaveBeenCalled();

    releaseBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(record!.id)!.promise?.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    expect(manager.getRecord(id)!.status).toBe("running");
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("never fires onStarted for a queued resume that is stopped before it drains", async () => {
    manager = new AgentManager(undefined, 1);
    const id = await spawnSettled(manager);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
      isBackground: true,
    });

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    const onStarted = vi.fn();
    await manager.resume(id, "later", undefined, { isBackground: true, onStarted });

    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("stopped");
    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe("AgentManager — names as additive aliases", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  const spawnNamed = (m: AgentManager, type: string, name?: string) =>
    m.spawn(mockPi, mockCtx, type, "go", {
      description: "go",
      ...(name !== undefined && { name }),
      isBackground: true,
    });

  it("assigns the type handle as well as the alias", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "auth-audit"))!;

    expect(record.handle).toBe("explore");
    expect(record.alias).toBe("auth-audit");
  });

  it("reaches the same agent by either name", () => {
    resolvedRun();
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore", "auth-audit");

    expect(manager.resolveMention("auth-audit")).toMatchObject({ kind: "live", record: { id } });
    expect(manager.resolveMention("explore")).toMatchObject({ kind: "live", record: { id } });
  });

  it("slugs a name that isn't typeable rather than rejecting the spawn", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "Auth Audit!"))!;

    expect(record.alias).toBe("auth-audit");
  });

  it("numbers an alias that collides with its own type handle", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "explore"))!;

    expect(record.handle).toBe("explore");
    expect(record.alias).toBe("explore-2");
  });

  it("stops a later type handle from colliding with an existing alias", () => {
    resolvedRun();
    manager = new AgentManager();
    spawnNamed(manager, "Plan", "explore");
    const second = manager.getRecord(spawnNamed(manager, "Explore"))!;

    expect(second.handle).toBe("explore-2");
  });

  it("refuses to alias an agent to the reserved main handle", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "main"))!;

    expect(record.alias).toBe("main-2");
  });

  it("gives an unnamed agent no alias at all", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore"))!;

    expect(record.alias).toBeUndefined();
    expect(record.handle).toBe("explore");
  });

  it("never names a nested child, however it was spawned", () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "go",
      name: "child",
      parentAgentId: "parent-1",
      isBackground: true,
    });

    const record = manager.getRecord(id)!;
    expect(record.alias).toBeUndefined();
    expect(record.handle).toBeUndefined();
    expect(manager.resolveMention("child")).toBeUndefined();
  });

  it("captures the session file so the agent can be resumed after eviction", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => "/sessions/explore.jsonl" },
      });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore");
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.sessionFile).toBe("/sessions/explore.jsonl");
  });

  it("records no session file for an in-memory session", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ dispose: vi.fn(), sessionManager: { getSessionFile: () => undefined } });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore");
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.sessionFile).toBeUndefined();
  });
});

describe("AgentManager — effective model and thinking write-back", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose?.();
    vi.restoreAllMocks();
  });

  async function spawnWithSession(
    invocation: AgentRecord["invocation"],
    runtime: { model?: { provider: string; id: string; name?: string }; thinkingLevel?: string },
  ): Promise<AgentRecord> {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ dispose: vi.fn(), ...runtime });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "go",
      isBackground: true,
      invocation,
    });
    await manager.getRecord(id)!.promise;
    return manager.getRecord(id)!;
  }

  it("relabels the record with the model the session actually runs", async () => {
    const record = await spawnWithSession(
      { modelName: "pre-session", modelId: "pre/session", thinking: "high" },
      { model: { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, thinkingLevel: "high" },
    );

    expect(record.invocation).toMatchObject({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
    });
  });

  it("keeps the requested level when pi clamps it to what the model supports", async () => {
    const record = await spawnWithSession(
      { thinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" },
    );

    expect(record.invocation!.thinking).toBe("high");
    expect(record.invocation!.requestedThinking).toBe("max");
  });

  it("records no request when the level was honored", async () => {
    const record = await spawnWithSession(
      { thinking: "high" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" },
    );

    expect(record.invocation!.requestedThinking).toBeUndefined();
  });

  it("does not overwrite a request the agent file already overrode", async () => {
    const record = await spawnWithSession(
      { thinking: "low", requestedThinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "minimal" },
    );

    expect(record.invocation!.thinking).toBe("minimal");
    expect(record.invocation!.requestedThinking).toBe("max");
  });

  it("gives a spawn that carried no invocation one to display", async () => {
    const record = await spawnWithSession(
      undefined,
      { model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "xhigh" },
    );

    expect(record.invocation).toEqual({
      modelName: "gpt-5.6-sol",
      modelId: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
    });
  });

  it("keeps the requested level when the session reports no level of its own", async () => {
    const record = await spawnWithSession(
      { thinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" } },
    );

    expect(record.invocation!.thinking).toBe("max");
    expect(record.invocation!.requestedThinking).toBeUndefined();
    expect(record.invocation!.modelName).toBe("claude-haiku-4-5");
  });

  it("leaves the invocation alone when the session reports no model", async () => {
    const record = await spawnWithSession({ thinking: "max" }, {});

    expect(record.invocation).toEqual({ thinking: "max" });
  });
});
