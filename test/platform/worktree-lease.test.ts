import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktreeOutcome } from "../../src/manager/worktree-outcome.js";
import { acquireWorktreeLease, cleanupWorktree, createWorktree, releaseWorktreeLease, restoreWorktree, type WorktreeInfo, worktreeResumeState } from "../../src/platform/worktree.js";

const pi = {
  exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
    try {
      const stdout = execFileSync(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8", stdio: "pipe" });
      return { stdout, stderr: "", code: 0, killed: false };
    } catch (error) {
      const err = error as { stderr?: Buffer; status?: number };
      return { stdout: "", stderr: String(err.stderr ?? error), code: err.status ?? 1, killed: false };
    }
  },
} as unknown as ExtensionAPI;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

describe("worktree leases", () => {
  let repo: string;
  let worktree: WorktreeInfo;
  let lease: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "pi-lease-test-"));
    git(repo, "init");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "commit", "--allow-empty", "-m", "initial");
    worktree = (await createWorktree(pi, repo, "lease-test"))!;
    expect(worktree).toBeDefined();
    lease = join(git(worktree.path, "rev-parse", "--absolute-git-dir"), "pi-agent-lease");
  });

  afterEach(() => {
    if (worktree) rmSync(worktree.path, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("acquires on creation and permits only one concurrent acquisition", async () => {
    expect(readFileSync(lease, "utf8")).toBe(worktree.leaseToken);
    await releaseWorktreeLease(worktree);
    const first = { ...worktree };
    const second = { ...worktree };
    const results = await Promise.allSettled([acquireWorktreeLease(first), acquireWorktreeLease(second)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && String(rejected.reason)).toContain(lease);
  });

  it("refuses cleanup from another holder without changing the worktree", async () => {
    writeFileSync(join(worktree.path, "uncommitted.txt"), "unsaved");
    const other = restoreWorktree(worktreeResumeState(worktree, worktree.path), pi);
    const outcome = await cleanupWorktree(pi, repo, other, "other holder");
    expect(outcome.failure).toContain("does not hold the worktree lease");
    expect(git(worktree.path, "status", "--porcelain")).toContain("uncommitted.txt");
    expect(readFileSync(lease, "utf8")).toBe(worktree.leaseToken);
  });

  it("releases a retained worktree after the cleanup tail fails to remove it", async () => {
    const refusing = {
      exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
        if (args[0] === "worktree" && args[1] === "remove") return { code: 1, stdout: "", stderr: "busy", killed: false };
        return pi.exec(command, args, options);
      },
    } as unknown as ExtensionAPI;
    worktree.pi = refusing;
    const record = { worktree, description: "test" };
    await cleanupWorktreeOutcome(record as never, "test");
    expect(worktree.leaseToken).toBeUndefined();
    const next = restoreWorktree(worktreeResumeState(worktree, worktree.path), pi);
    await acquireWorktreeLease(next);
    await releaseWorktreeLease(next);
  });

  it("releases only with the matching token", async () => {
    await expect(releaseWorktreeLease({ ...worktree, leaseToken: "wrong" })).rejects.toThrow(lease);
    expect(readFileSync(lease, "utf8")).toBe(worktree.leaseToken);
    await releaseWorktreeLease(worktree);
    expect(worktree.leaseToken).toBeUndefined();
    await acquireWorktreeLease(worktree);
  });

  it.each(["", "malformed", "00000000-0000-4000-8000-000000000000"])("never breaks an existing lease: %s", async (content) => {
    await releaseWorktreeLease(worktree);
    writeFileSync(lease, content);
    await expect(acquireWorktreeLease(worktree)).rejects.toThrow(lease);
    expect(readFileSync(lease, "utf8")).toBe(content);
  });

  it("refuses a worktree registered to another repository", async () => {
    const other = mkdtempSync(join(tmpdir(), "pi-lease-other-"));
    try {
      git(other, "init");
      await expect(acquireWorktreeLease({ ...worktree, repoPath: other, leaseToken: undefined })).rejects.toThrow();
      expect(readFileSync(lease, "utf8")).toBe(worktree.leaseToken);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("reports the retained path if lease acquisition fails after creation", async () => {
    let created = "";
    const refusing = {
      exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
        if (args[0] === "worktree" && args[1] === "add") created = args.at(-2)!;
        if (args[0] === "worktree" && args[1] === "list") return { code: 1, stdout: "", stderr: "unavailable", killed: false };
        return pi.exec(command, args, options);
      },
    } as unknown as ExtensionAPI;
    try {
      await expect(createWorktree(refusing, repo, "lease-failure")).rejects.toThrow(/remains on disk/);
      expect(created.startsWith(`${tmpdir()}/pi-agent-lease-failure-`)).toBe(true);
      expect(git(repo, "worktree", "list", "--porcelain")).toContain(created);
    } finally {
      if (created) {
        git(repo, "worktree", "unlock", created);
        git(repo, "worktree", "remove", created);
      }
    }
  });

  it("never writes a lease in the main checkout", async () => {
    await expect(acquireWorktreeLease({ ...worktree, path: repo, workPath: repo, leaseToken: undefined })).rejects.toThrow();
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});
