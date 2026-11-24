import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager as BaseAgentManager } from "../src/manager/agent-manager.js";
import { GrantingAgentManager as AgentManager, grant } from "./harness/capability.js";

const captured = vi.hoisted(() => ({ manager: undefined as BaseAgentManager | undefined }));

vi.mock("../src/manager/agent-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/manager/agent-manager.js")>();
  return { ...actual, AgentManager: class extends actual.AgentManager {
    constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
      super(...args);
      captured.manager = this;
    }
  } };
});

vi.mock("../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/platform/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/platform/worktree.js")>();
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
    pruneWorktrees: vi.fn().mockResolvedValue(undefined),
    isWorktreeIsolationEnabled: vi.fn(() => false),
    isWorktreeRetained: vi.fn(() => true),
    verifyWorktreeResume: vi.fn(async () => undefined),
    acquireWorktreeLease: vi.fn(async () => undefined),
    releaseWorktreeLease: vi.fn(async () => undefined),
  };
});

import subagentsExtension from "../src/index.js";
import { isolationFields, rebuildTombstones, resolveMention } from "../src/manager/agent-retention.js";
import { formatTaskNotification } from "../src/manager/notification-format.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "../src/platform/worktree.js";
import { resumeAgent, runAgent } from "../src/session/agent-runner.js";
import { registerMentionInput } from "../src/triggers/mention-input.js";

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

  it("keeps forced-settle cleanup uncertainty after late cleanup and a restart rebuild", async () => {
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.({ ...mockSession(), sessionManager: { getSessionFile: () => fileURLToPath(import.meta.url) } } as any);
      return new Promise((resolve) => { resolveRun = resolve; }) as any;
    });
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
    vi.mocked(createWorktree).mockResolvedValue({ path: "/tmp/wt", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/tmp/wt", repoPath: "/repo", pi: mockPi } as any);
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "saved", path: "/tmp/wt" } as any);
    const entries: any[] = [];
    manager = new AgentManager((record) => entries.push({ type: "custom", customType: "agent:record", data: {
      id: record.id, type: record.type, description: record.description, status: record.status,
      handle: record.handle, sessionFile: record.sessionFile, completedAt: record.completedAt, ...isolationFields(record),
    } }));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);
    const record = manager.getRecord(id)!;
    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ isolation: "worktree", cleanupPending: true, worktree: { path: "/tmp/wt" } });
    expect(cleanupWorktree).not.toHaveBeenCalled();

    resolveRun({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await record.promise;
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);

    const state = { agents: new Map(), activities: new Map(), startups: new Map(), tombstones: new Map() };
    rebuildTombstones(state, entries as any);
    expect(state.tombstones.get(record.handle!)).toMatchObject({ cleanupPending: true, isolation: "worktree" });
    const on = vi.fn();
    const spawnResolved = vi.fn();
    const notify = vi.fn();
    registerMentionInput({ on } as any, {
      manager: { resolveMention: (name: string) => resolveMention(state, name) },
      settings: { agentMentionMode: "direct" }, isAgentMentionsEnabled: () => true, spawnResolved,
    } as any);
    await on.mock.calls[0][1]({ source: "interactive", text: `@${record.handle} continue` }, { mode: "tui", ui: { notify } });
    expect(notify).toHaveBeenCalledWith(`Could not resume @${record.handle} — its worktree cleanup may not have finished`, "warning");
    expect(spawnResolved).not.toHaveBeenCalled();
    expect(state.tombstones.has(record.handle!)).toBe(true);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(record.worktreeResult).toBeUndefined();

    manager.abort(id, "user");
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(completed).toEqual(["completed", "stopped"]);
    expect(isolationFields(record).cleanupPending).toBe(true);
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

  it("hides a queued reopen's prior result from its stopped notification", () => {
    wedge();
    manager = new AgentManager(undefined, 1);
    manager.spawn(mockPi, mockCtx, "X", "occupy", { description: "occupy", isBackground: true });
    const id = manager.spawn(mockPi, mockCtx, "X", "resume", {
      description: "resume", isBackground: true, reclaim: { handle: "audit", result: "previous result" },
      resumeSessionFile: "/sessions/agent.jsonl",
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("queued");
    manager.abort(id, "user");
    expect(record.status).toBe("stopped");
    expect(record.recoveryResult).toBe("previous result");
    expect(formatTaskNotification(record, 300)).toContain("<result>No output.</result>");
    expect(formatTaskNotification(record, 300)).not.toContain("previous result");
  });

  it("persists a queued worktree reopen on shutdown without acquiring or cleaning it", async () => {
    vi.mocked(runAgent).mockReset();
    wedge();
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = {
      registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
      on: vi.fn((name, handler) => handlers.set(name, handler)),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
    };
    subagentsExtension(pi as any);
    const extensionManager = captured.manager!;
    extensionManager.setMaxConcurrent(1);
    const capability = grant();
    extensionManager.spawn(pi as any, mockCtx, "X", "occupy", { description: "occupy", isBackground: true, capability });
    const worktree = { path: "/tmp/wt", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/tmp/wt", repoPath: "/repo", cwd: "/tmp/wt" };
    const id = extensionManager.spawn(pi as any, mockCtx, "X", "resume", {
      description: "resume", isBackground: true, capability, sessionId: "reopened", reclaim: { handle: "audit", alias: "reviewer", result: "previous result" },
      resumeSessionFile: "/sessions/agent.jsonl", resumeWorktree: worktree,
    });
    expect(extensionManager.getRecord(id)?.status).toBe("queued");
    const queued = extensionManager.getRecord(id)!;
    expect(queued.result).toBeUndefined();
    expect(queued.recoveryResult).toBe("previous result");
    expect(formatTaskNotification(queued, 300)).not.toContain("previous result");
    await handlers.get("session_shutdown")!();
    const entries = pi.appendEntry.mock.calls.filter(([name]) => name === "agent:record").map(([, data]) => data);
    expect(entries.filter((entry) => entry.id === id)).toEqual([expect.objectContaining({
      id, status: "stopped", stopCause: "shutdown", handle: "audit", alias: "reviewer",
      sessionFile: "/sessions/agent.jsonl", isolation: "worktree", worktree, result: "previous result",
    })]);
    expect(entries.find((entry) => entry.id === id)).not.toHaveProperty("cleanupPending");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
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
