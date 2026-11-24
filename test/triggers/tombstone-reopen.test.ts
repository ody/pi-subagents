import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type RetentionDeps, resolveMention } from "../../src/manager/agent-retention.js";
import { createWorktree, type WorktreeResumeState, worktreeResumeState } from "../../src/platform/worktree.js";
import { registerMentionInput } from "../../src/triggers/mention-input.js";
import type { AgentTombstone } from "../../src/types.js";

const SESSION_ID = "0197a1b2-c3d4-7e5f-8a6b-1234567890ab";

function realExec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
  if (!options?.cwd?.startsWith(`${tmpdir()}/`)) throw new Error("Git test cwd must be under the temporary directory");
  try {
    const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return Promise.resolve({ stdout, stderr: "", code: 0, killed: false });
  } catch (err: any) {
    return Promise.resolve({ stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false });
  }
}

function boot(entry: AgentTombstone) {
  const retention: RetentionDeps = {
    agents: new Map(), activities: new Map(), startups: new Map(),
    tombstones: new Map([[entry.handle, entry]]),
  };
  const on = vi.fn();
  const notify = vi.fn();
  const spawnResolved = vi.fn(() => "reopened-id");
  const pi = { on, exec: realExec };
  registerMentionInput(pi as never, {
    manager: { resolveMention: (handle) => resolveMention(retention, handle), steer: vi.fn(), awaitStartup: vi.fn() },
    settings: { agentMentionMode: "direct" },
    isAgentMentionsEnabled: () => true,
    spawnResolved,
    spawnTopLevel: vi.fn(),
    startBackgroundResume: vi.fn(),
    reloadCustomAgents: vi.fn(),
    agentTool: undefined,
  } as never);
  return { retention, input: on.mock.calls[0][1], notify, spawnResolved, pi };
}

function entry(overrides: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    id: "agent-id", handle: "audit", alias: "reviewer", type: "Explore",
    description: "audit", sessionFile: join(tmpdir(), `missing-${SESSION_ID}.jsonl`),
    completedAt: 1, status: "completed", result: "saved result",
    agentConfig: { name: "Explore", description: "audit", systemPrompt: "audit" },
    ...overrides,
  };
}

function writeSession(path: string, cwd: string): void {
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(0).toISOString(), cwd })}\n`);
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "reopen-repo-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init");
  run("config", "user.email", "test@test.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Test");
  run("add", "README.md");
  run("commit", "-m", "initial");
  return dir;
}

async function reopen(tombstone: AgentTombstone) {
  const booted = boot(tombstone);
  const ctx = { mode: "tui", ui: { notify: booted.notify } };
  const result = await booted.input({ source: "interactive", text: "@reviewer continue" }, ctx);
  expect(result).toEqual({ action: "handled" });
  return { ...booted, ctx };
}

function withSession<T>(cwd: string | undefined, body: (sessionFile: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "reopen-session-"));
  const sessionFile = join(directory, "session.jsonl");
  writeSession(sessionFile, cwd ?? directory);
  return body(sessionFile).finally(() => rmSync(directory, { recursive: true, force: true }));
}

describe("reopening a tombstone", () => {
  it("keeps the tombstone and reports the missing session path", async () => {
    const tombstone = entry();
    const { retention, notify, spawnResolved } = await reopen(tombstone);

    expect(notify).toHaveBeenCalledWith(`Could not resume @reviewer — its session file is missing: ${tombstone.sessionFile}`, "warning");
    expect(resolveMention(retention, "reviewer")).toEqual({ kind: "tombstone", entry: tombstone });
    expect(retention.tombstones.get("audit")?.result).toBe("saved result");
    expect(spawnResolved).not.toHaveBeenCalled();
  });

  it("refuses an entry with no isolation state", async () => {
    await withSession(undefined, async (sessionFile) => {
      const { retention, notify, spawnResolved } = await reopen(entry({ sessionFile }));
      expect(notify).toHaveBeenCalledWith("Could not resume @reviewer — its isolation state is unknown", "warning");
      expect(retention.tombstones.has("audit")).toBe(true);
      expect(spawnResolved).not.toHaveBeenCalled();
    });
  });

  it("reopens an entry that records no isolation", async () => {
    await withSession(undefined, async (sessionFile) => {
      const { spawnResolved } = await reopen(entry({ sessionFile, isolation: "none" }));
      expect(spawnResolved).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "Explore", "continue",
        expect.objectContaining({ cwd: join(sessionFile, "..") }),
      );
    });
  });

  it("refuses a non-isolated entry whose original working directory is missing", async () => {
    await withSession(join(tmpdir(), `missing-cwd-${SESSION_ID}`), async (sessionFile) => {
      const { notify, spawnResolved } = await reopen(entry({ sessionFile, isolation: "none" }));
      expect(notify).toHaveBeenCalledWith("Could not resume @reviewer: Session working directory is missing", "warning");
      expect(spawnResolved).not.toHaveBeenCalled();
    });
  });

  it("refuses a worktree entry whose saved state is invalid", async () => {
    await withSession(undefined, async (sessionFile) => {
      const { notify, spawnResolved } = await reopen(entry({ sessionFile, isolation: "worktree" }));
      expect(notify).toHaveBeenCalledWith("Could not resume @reviewer — its saved worktree state is invalid", "warning");
      expect(spawnResolved).not.toHaveBeenCalled();
    });
  });

  it("refuses an entry that records no isolation but carries a worktree", async () => {
    await withSession(undefined, async (sessionFile) => {
      const state: WorktreeResumeState = { path: "/w", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/w", repoPath: "/r", cwd: "/w" };
      const { notify, spawnResolved } = await reopen(entry({ sessionFile, isolation: "none", worktree: state }));
      expect(notify).toHaveBeenCalledWith("Could not resume @reviewer — its isolation state is inconsistent", "warning");
      expect(spawnResolved).not.toHaveBeenCalled();
    });
  });

  it("refuses an entry whose cleanup may not have finished", async () => {
    await withSession(undefined, async (sessionFile) => {
      const { notify, spawnResolved } = await reopen(entry({ sessionFile, isolation: "none", cleanupPending: true }));
      expect(notify).toHaveBeenCalledWith("Could not resume @reviewer — its worktree cleanup may not have finished", "warning");
      expect(spawnResolved).not.toHaveBeenCalled();
    });
  });

  it("refuses a reopen whose isolated worktree was removed", async () => {
    const repo = initRepo();
    try {
      await withSession(undefined, async (sessionFile) => {
        const gone = join(repo, "gone");
        const removed: WorktreeResumeState = { path: gone, branch: "b", baseSha: "abc", ownerToken: "token", workPath: gone, repoPath: repo, cwd: gone };
        const tombstone = entry({ sessionFile, isolation: "worktree", worktree: removed });
        const { retention, notify, spawnResolved } = await reopen(tombstone);

        expect(notify).toHaveBeenCalledWith(`Could not resume @reviewer — its worktree was removed: ${gone}`, "warning");
        expect(resolveMention(retention, "reviewer")).toEqual({ kind: "tombstone", entry: tombstone });
        expect(spawnResolved).not.toHaveBeenCalled();
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a worktree that Git does not register to the saved repository", async () => {
    const repo = initRepo();
    const plain = mkdtempSync(join(tmpdir(), "reopen-plain-"));
    try {
      await withSession(undefined, async (sessionFile) => {
        const state: WorktreeResumeState = { path: plain, branch: "b", baseSha: "abc", ownerToken: "token", workPath: plain, repoPath: repo, cwd: plain };
        const { notify, spawnResolved } = await reopen(entry({ sessionFile, isolation: "worktree", worktree: state }));
        expect(notify).toHaveBeenCalledWith(`Could not resume @reviewer — Git does not register ${plain} as a worktree of ${repo}`, "warning");
        expect(spawnResolved).not.toHaveBeenCalled();
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reopens in the verified worktree and hands the manager its cleanup state", async () => {
    const repo = initRepo();
    try {
      const wt = (await createWorktree({ exec: realExec } as never, repo, "agent-id"))!;
      const state = worktreeResumeState(wt, wt.path);
      await withSession(wt.path, async (sessionFile) => {
        const { spawnResolved, notify, ctx } = await reopen(entry({ sessionFile, isolation: "worktree", worktree: state }));
        expect(spawnResolved).toHaveBeenCalledWith(
          expect.anything(), ctx, "Explore", "continue",
          expect.objectContaining({ resumeSessionFile: sessionFile, sessionId: SESSION_ID, resumeWorktree: state, cwd: wt.path }),
        );
        expect(notify).toHaveBeenCalledWith("Resuming @reviewer", "info");
      });
      execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["worktree", "remove", wt.path], { cwd: repo, stdio: "pipe" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
