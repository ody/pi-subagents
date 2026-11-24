import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildTombstones } from "../../src/manager/agent-retention.js";
import { acquireWorktreeLease, createWorktree, releaseWorktreeLease, restoreWorktree, type WorktreeInfo, worktreeResumeState } from "../../src/platform/worktree.js";
import { runAgent } from "../../src/session/agent-runner.js";
import { GrantingAgentManager as AgentManager } from "../harness/capability.js";

vi.mock("../../src/session/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

const pi = {
  exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
    if (args[0] === "worktree" && args[1] === "remove") return { stdout: "", stderr: "busy", code: 1, killed: false };
    try {
      return { stdout: execFileSync(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8", stdio: "pipe" }), stderr: "", code: 0, killed: false };
    } catch (error) {
      const err = error as { stderr?: Buffer; status?: number };
      return { stdout: "", stderr: String(err.stderr ?? error), code: err.status ?? 1, killed: false };
    }
  },
} as unknown as ExtensionAPI;

describe("worktree lease lifecycle", () => {
  let repo: string;
  let worktree: WorktreeInfo;
  let lease: string;
  let manager: AgentManager;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "pi-lease-lifecycle-"));
    git(repo, "init");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "commit", "--allow-empty", "-m", "initial");
    worktree = (await createWorktree(pi, repo, "lifecycle"))!;
    lease = join(git(worktree.path, "rev-parse", "--absolute-git-dir"), "pi-agent-lease");
    vi.mocked(runAgent).mockReset();
  });

  afterEach(async () => {
    await manager?.dispose();
    vi.useRealTimers();
    if (worktree) rmSync(worktree.path, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("holds the lease through forced settlement and releases it only after late cleanup", async () => {
    await releaseWorktreeLease(worktree);
    const state = worktreeResumeState(worktree, worktree.path);
    const completed = vi.fn();
    let finish!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    manager = new AgentManager(completed);
    const id = manager.spawn(pi, { cwd: repo } as never, "X", "resume", { description: "resume", isBackground: true, resumeWorktree: state, resumeSessionFile: "/session" });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    expect(runAgent).toHaveBeenCalledOnce();
    const token = readFileSync(lease, "utf8");
    vi.useFakeTimers();
    expect(manager.abort(id, "user")).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completed).toHaveBeenCalledOnce();
    expect(record.status).toBe("stopped");
    const contender = restoreWorktree(state, pi);
    await expect(acquireWorktreeLease(contender)).rejects.toThrow();
    expect(readFileSync(lease, "utf8")).toBe(token);
    finish({ responseText: "late", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
    await record.promise;
    expect(record.worktreeResult?.removalFailure).toBeDefined();
    expect(completed).toHaveBeenCalledOnce();
    expect(record.status).toBe("stopped");
    await acquireWorktreeLease(contender);
    await releaseWorktreeLease(contender);
  });

  it("aborts a queued reopen without acquiring or cleaning its worktree", async () => {
    await releaseWorktreeLease(worktree);
    const state = worktreeResumeState(worktree, worktree.path);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    manager.spawn(pi, { cwd: repo } as never, "X", "occupy", { description: "occupy", isBackground: true });
    const id = manager.spawn(pi, { cwd: repo } as never, "X", "resume", { description: "resume", isBackground: true, resumeWorktree: state, resumeSessionFile: "/session", reclaim: { handle: "audit", result: "prior" } });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("queued");
    expect(manager.abort(id, "user")).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.sessionFile).toBe("/session");
    expect(record.worktreeResume).toEqual(state);
    expect(record.worktree).toBeUndefined();
    expect(runAgent).toHaveBeenCalledOnce();
    const contender = restoreWorktree(state, pi);
    await acquireWorktreeLease(contender);
    await releaseWorktreeLease(contender);
  });

  it("refuses a stale crash lease when a prior tombstone is retained", async () => {
    const state = worktreeResumeState(worktree, worktree.path);
    const token = readFileSync(lease, "utf8");
    const retained = { agents: new Map(), activities: new Map(), startups: new Map(), tombstones: new Map() };
    rebuildTombstones(retained, [{ type: "custom", customType: "agent:record", data: { id: "prior", handle: "audit", type: "X", description: "prior", sessionFile: "/session", status: "completed", completedAt: 1, isolation: "worktree", worktree: state } }] as never);
    expect(retained.tombstones.get("audit")).toMatchObject({ id: "prior", worktree: state });
    const completed = vi.fn();
    manager = new AgentManager(completed);
    const id = manager.spawn(pi, { cwd: repo } as never, "X", "resume", { description: "resume", isBackground: true, resumeWorktree: state, resumeSessionFile: "/session" });
    await expect(manager.awaitStartup(id)).rejects.toThrow("Could not acquire worktree lease");
    expect(runAgent).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][0].status).toBe("error");
    expect(readFileSync(lease, "utf8")).toBe(token);
    expect(retained.tombstones.get("audit")).toMatchObject({ id: "prior", worktree: state });
  });
});
