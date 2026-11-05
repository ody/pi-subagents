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
}));

import { runAgent } from "../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const TEN_MINUTES = 10 * 60_000;
const TICK = 60_000;

describe("AgentManager — record GC", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function settled(prompt: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.getRecord(id)!.promise;
    return { id, record: manager.getRecord(id)! };
  }

  it("keeps a record that completed inside the retention window", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("recent");
    record.completedAt = Date.now() - (TEN_MINUTES - 2 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("evicts a record that completed before the cutoff and disposes its session", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.listAgents().map(a => a.id)).not.toContain(id);
    expect(dispose).toHaveBeenCalled();
  });

  it("closes the evicted session's extension lifecycle before disposing it (#242)", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const emit = vi.fn(async () => {});
    const dispose = vi.fn();
    record.session = {
      dispose,
      extensionRunner: { hasHandlers: (event: string) => event === "session_shutdown", emit },
    } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
  });

  it("never evicts a running agent, however old its timestamp looks", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "live", { description: "live", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    record.completedAt = Date.now() - 10 * TEN_MINUTES;
    const dispose = vi.fn();
    record.session = { dispose } as any;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never evicts a queued agent", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    manager.spawn(mockPi, mockCtx, "X", "holder", { description: "holder", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "waiter", { description: "waiter", isBackground: true });
    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    queued.completedAt = Date.now() - 10 * TEN_MINUTES;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(queuedId)?.status).toBe("queued");
  });

  it("sweeps repeatedly, not just once", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("ages-out");
    record.completedAt = Date.now() - (TEN_MINUTES - 3 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeDefined();

    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

describe("AgentManager — tombstones outliving the GC", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function evictable(type: string, prompt: string, sessionFile?: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, type, prompt, { description: prompt, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = sessionFile;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    return { id, record };
  }

  it("keeps an evicted agent reachable by name when its session is on disk", async () => {
    manager = new AgentManager();
    await evictable("Explore", "audit the RPC path", "/sessions/explore.jsonl");

    await vi.advanceTimersByTimeAsync(TICK);

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("tombstone");
    expect(resolved).toMatchObject({
      entry: { handle: "explore", type: "Explore", description: "audit the RPC path", sessionFile: "/sessions/explore.jsonl" },
    });
  });

  it("leaves nothing behind when the session was only ever in memory", async () => {
    manager = new AgentManager();
    await evictable("Explore", "ephemeral", undefined);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.resolveMention("explore")).toBeUndefined();
    expect(manager.listTombstones()).toHaveLength(0);
  });

  it("holds the evicted handle so a later agent of the same type can't shadow it", async () => {
    manager = new AgentManager();
    await evictable("Explore", "first", "/sessions/first.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);

    const id = manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });

    expect(manager.getRecord(id)!.handle).toBe("explore-2");
    expect(manager.resolveMention("explore")?.kind).toBe("tombstone");
  });

  it("prefers a live agent over a tombstone holding the same name", async () => {
    manager = new AgentManager();
    await evictable("Explore", "old", "/sessions/old.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "live", { description: "live", isBackground: true });
    manager.getRecord(id)!.handle = "explore";

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("live");
    expect(resolved).toMatchObject({ record: { id } });
  });

  it("drops the oldest once the cap is reached, keeping the most recent", async () => {
    manager = new AgentManager();
    for (let i = 0; i < 101; i++) {
      const { record } = await evictable("Explore", `run-${i}`, `/sessions/${i}.jsonl`);
      record.completedAt = Date.now() - (TEN_MINUTES + 101_000 - i * 1000);
    }
    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.listTombstones()).toHaveLength(100);
    expect(manager.resolveMention("explore")).toBeUndefined();
    expect(manager.resolveMention("explore-101")?.kind).toBe("tombstone");
  });

  it("hands a reclaimed name straight back, numbering nothing", async () => {
    manager = new AgentManager();
    await evictable("Explore", "first", "/sessions/first.jsonl");
    manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });
    await vi.advanceTimersByTimeAsync(TICK);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "resumed", {
      description: "first",
      isBackground: true,
      reclaim: { handle: "explore", alias: "auth-audit" },
    } as any);

    expect(manager.getRecord(id)).toMatchObject({ handle: "explore", alias: "auth-audit" });
  });

  it("ignores a reclaim on a nested child, which has no name to hold", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "child", {
      description: "child",
      parentAgentId: "parent-id",
      reclaim: { handle: "explore", alias: "auth-audit" },
    } as any);

    expect(manager.getRecord(id)).toMatchObject({ handle: undefined, alias: undefined });
  });

  it("stops answering a name once its tombstone is dropped", async () => {
    manager = new AgentManager();
    await evictable("Explore", "done", "/sessions/done.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.resolveMention("explore")?.kind).toBe("tombstone");

    manager.dropTombstone("explore");

    expect(manager.resolveMention("explore")).toBeUndefined();
    expect(manager.listTombstones()).toHaveLength(0);
  });

  it("frees a dropped name for the next agent of that type", async () => {
    manager = new AgentManager();
    await evictable("Explore", "done", "/sessions/done.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    manager.dropTombstone("explore");

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "next", { description: "next", isBackground: true });

    expect(manager.getRecord(id)!.handle).toBe("explore");
  });

  it("forgets every name when the session ends", async () => {
    manager = new AgentManager();
    await evictable("Explore", "prior session", "/sessions/prior.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.listTombstones()).toHaveLength(1);

    manager.clearCompleted(true);

    expect(manager.listTombstones()).toHaveLength(0);
    expect(manager.resolveMention("explore")).toBeUndefined();
  });
});
