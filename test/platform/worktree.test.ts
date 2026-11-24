import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireWorktreeLease,
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  isWorktreeRetained,
  parseWorktreeResumeState,
  pruneWorktrees,
  releaseWorktreeLease,
  restoreWorktree,
  setWorktreeIsolationEnabled,
  verifyWorktreeResume,
  worktreeResumeState,
} from "../../src/platform/worktree.js";

const createdPaths = new Set<string>();

afterEach(() => {
  for (const path of createdPaths) rmSync(path, { recursive: true, force: true });
  createdPaths.clear();
});

function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (!options?.cwd?.startsWith(`${tmpdir()}/`)) throw new Error("Git test cwd must be under the temporary directory");
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        if (args[0] === "worktree" && args[1] === "add") createdPaths.add(args[args.length - 2]);
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: any) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr: "boom", ...failure };
      return real.exec(command, args, options);
    }),
  } as unknown as ExtensionAPI;
}

function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function commitGitignore(dir: string): void {
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "add gitignore"], { cwd: dir, stdio: "pipe" });
}

describe("worktree", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });

  afterEach(async () => {
    try { await pruneWorktrees(pi, repoDir); } catch { }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", async () => {
      const wt = await createWorktree(pi, repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("records the repo path it was created from", async () => {
      const wt = (await createWorktree(pi, repoDir, "repo-path"))!;
      expect(wt.repoPath).toBe(repoDir);
      expect(wt.pi).toBe(pi);

      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("returns undefined for non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = await createWorktree(pi, nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = await createWorktree(pi, emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("returns undefined when `git worktree add` reports a non-zero exit", async () => {
      const wt = await createWorktree(
        failingPi(args => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }),
        repoDir,
        "add-fails",
      );
      expect(wt).toBeUndefined();
    });

    it("returns undefined when a git call is killed by its timeout", async () => {
      const wt = await createWorktree(
        failingPi(args => args[0] === "rev-parse" && args[1] === "HEAD", { code: 0, killed: true }),
        repoDir,
        "timed-out",
      );
      expect(wt).toBeUndefined();
    });

    it("workPath equals path when created from the repo root", async () => {
      const wt = (await createWorktree(pi, repoDir, "root-wp"))!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", async () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = (await createWorktree(pi, join(repoDir, "packages", "api"), "subdir-wp"))!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("uses unique paths for multiple worktrees", async () => {
      const wt1 = await createWorktree(pi, repoDir, "multi-1");
      const wt2 = await createWorktree(pi, repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
      const order: string[] = [];
      const tracking = {
        exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          order.push(`start:${args[0]}`);
          const result = await pi.exec(command, args, options);
          order.push(`end:${args[0]}`);
          return result;
        },
      } as unknown as ExtensionAPI;

      const [a, b] = await Promise.all([
        createWorktree(tracking, repoDir, "par-1"),
        createWorktree(tracking, repoDir, "par-2"),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      const interleaved = order.some((entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"));
      expect(interleaved).toBe(true);

      for (const wt of [a!, b!]) {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
      }
    });
  });

  describe("isWorktreeRetained", () => {
    it("is true while the path exists and false once cleanup removes it", async () => {
      const wt = (await createWorktree(pi, repoDir, "retained-1"))!;
      expect(isWorktreeRetained(wt)).toBe(true);

      await cleanupWorktree(pi, repoDir, wt, "test cleanup");
      expect(isWorktreeRetained(wt)).toBe(false);
    });

    it("is false for a path that never existed", () => {
      expect(isWorktreeRetained({ path: join(repoDir, "missing-worktree") })).toBe(false);
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", async () => {
      const wt = (await createWorktree(pi, repoDir, "clean-1"))!;
      expect(wt).toBeDefined();

      const result = await cleanupWorktree(pi, repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
      expect(result.removalFailure).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    });

    it("commits changes and creates branch when changes exist", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-1"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("preserves tracked and non-ignored untracked work but not ignored files", async () => {
      commitGitignore(repoDir);
      const wt = (await createWorktree(pi, repoDir, "ignored-1"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "README.md"), "# Test repo\n\ntracked edit\n");
      writeFileSync(join(wt.path, "agent-file.txt"), "agent wrote this");
      writeFileSync(join(wt.path, "ignored.log"), "build output");

      const result = await cleanupWorktree(pi, repoDir, wt, "ignored files stay out");

      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-ignored-1");

      const trackedContent = execFileSync("git", ["show", `${result.branch}:README.md`], {
        cwd: repoDir, stdio: "pipe",
      }).toString();
      expect(trackedContent).toContain("tracked edit");

      const files = execFileSync("git", ["ls-tree", "-r", "--name-only", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString();
      expect(files).toContain("agent-file.txt");
      expect(files).not.toContain("ignored.log");
      expect(existsSync(wt.path)).toBe(false);
    });

    it("discards ignored files and keeps no branch when an agent only writes ignored output", async () => {
      commitGitignore(repoDir);
      const wt = (await createWorktree(pi, repoDir, "ignored-only"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "ignored.log"), "build output");
      expect(existsSync(join(wt.path, "ignored.log"))).toBe(true);

      const result = await cleanupWorktree(pi, repoDir, wt, "ignored output only");

      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
      expect(existsSync(join(wt.path, "ignored.log"))).toBe(false);
    });

    it("commits changes even when a pre-commit hook rejects (--no-verify)", async () => {
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = (await createWorktree(pi, repoDir, "hooked-1"))!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("creates branch when worktree is clean but HEAD moved", async () => {
      const wt = (await createWorktree(pi, repoDir, "committed-1"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = await cleanupWorktree(pi, repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("does not force-overwrite existing branch", async () => {
      const wt1 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = await cleanupWorktree(pi, repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      const wt2 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = await cleanupWorktree(pi, repoDir, wt2, "second");

      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("reports unknown changes and names the path when the worktree is already gone", async () => {
      const wt = (await createWorktree(pi, repoDir, "gone-1"))!;
      rmSync(wt.path, { recursive: true, force: true });

      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");

      expect(result.hasChanges).toBe(true);
      expect(result.unknownChanges).toBe(true);
      expect(result.path).toBe(wt.path);
      expect(result.branch).toBeUndefined();
      expect(result.failure).toBeUndefined();
      expect(result.removalFailure).toBeUndefined();
    });

    it("truncates commit message at 200 chars", async () => {
      const wt = (await createWorktree(pi, repoDir, "long-msg"))!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = await cleanupWorktree(pi, repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log.length).toBeLessThanOrEqual(220);

      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("reports a removal failure and the path when pruning leaves the worktree in place", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");

      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
      expect(result.removalFailure).toBe("boom");
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);
      expect(await verifyWorktreeResume(pi, worktreeResumeState(wt, wt.path))).toBeUndefined();
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });

    it("keeps the saved branch alongside a removal failure", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails-changed"))!;
      writeFileSync(join(wt.path, "changed.txt"), "agent output");
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      const result = await cleanupWorktree(failing, repoDir, wt, "removal fails with work");

      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-remove-fails-changed");
      expect(result.removalFailure).toBe("boom");
      expect(result.path).toBe(wt.path);
      expect(result.failure).toBeUndefined();
      expect(existsSync(wt.path)).toBe(true);
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString();
      expect(branches).toContain(result.branch!);

      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject on a clean repo", async () => {
      await expect(pruneWorktrees(pi, repoDir)).resolves.toBeUndefined();
    });

    it("does not reject on non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(pruneWorktrees(pi, nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

describe("cleanupWorktree — failure path", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => { repoDir = initGitRepo(); pi = mockPi(); });
  afterEach(async () => {
    try { await pruneWorktrees(pi, repoDir); } catch { }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("keeps a worktree with a broken git link and reports the failure and path", async () => {
    const wt = (await createWorktree(pi, repoDir, "corrupt"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    try {
      const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent");

      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeUndefined();
      expect(result.failure).toBeTruthy();
      expect(result.path).toBe(wt.path);
      expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    } finally {
      rmSync(wt.path, { recursive: true, force: true });
    }
  });

  it("keeps the worktree and reports stderr and path when the preservation commit fails", async () => {
    const wt = (await createWorktree(pi, repoDir, "commit-fails"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(
      failingPi(args => args[0] === "commit", { code: 1, killed: false }),
      repoDir,
      wt,
      "commit fails",
    );

    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.failure).toContain("boom");
    expect(result.path).toBe(wt.path);
    expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
  });

  it("creates the branch when commit.gpgsign is on and gpg.program is unreachable", async () => {
    execFileSync("git", ["config", "commit.gpgsign", "true"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "gpg.program", "/nonexistent/gpg"], { cwd: repoDir, stdio: "pipe" });
    const wt = (await createWorktree(pi, repoDir, "unsigned"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(pi, repoDir, wt, "unsigned agent");

    expect(result.failure).toBeUndefined();
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeDefined();
    expect(existsSync(wt.path)).toBe(false);
  });

  it("creates the branch BEFORE removing the worktree, so a removal failure cannot lose commits", async () => {
    const wt = (await createWorktree(pi, repoDir, "ordered"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(pi, repoDir, wt, "ordered agent");

    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeDefined();
    const branches = execFileSync("git", ["branch", "--list", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(branches).toContain(result.branch!);
    expect(existsSync(wt.path)).toBe(false);
    const files = execFileSync("git", ["ls-tree", "--name-only", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(files).toContain("work.txt");
  });
});

describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("does not disable createWorktree directly", async () => {
    const repoDir = initGitRepo();
    const pi = mockPi();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = await createWorktree(pi, repoDir, "switch-test");
      expect(wt).toBeDefined();
      await cleanupWorktree(pi, repoDir, wt!, "switch test");
    } finally {
      await pruneWorktrees(pi, repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("worktree resume state", () => {
  it("round-trips without the pi handle", () => {
    const pi = mockPi();
    const worktree = { path: "/w", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/w/sub", repoPath: "/repo", pi };
    const state = worktreeResumeState(worktree, "/w/sub");

    expect(state).toEqual({ path: "/w", branch: "b", baseSha: "abc", ownerToken: "token", workPath: "/w/sub", repoPath: "/repo", cwd: "/w/sub" });
    expect(state).not.toHaveProperty("pi");
    expect(restoreWorktree(state, pi)).toEqual(worktree);
    expect(parseWorktreeResumeState(state)).toEqual(state);
  });

  it.each([
    { label: "a non-object", value: "worktree" },
    { label: "a legacy state without owner token", value: { path: "/w", branch: "b", baseSha: "abc", workPath: "/w", repoPath: "/repo", cwd: "/w" } },
    { label: "a missing field", value: { path: "/w", branch: "b", baseSha: "abc", workPath: "/w", repoPath: "/repo" } },
    { label: "an empty field", value: { path: "/w", branch: "", baseSha: "abc", workPath: "/w", repoPath: "/repo", cwd: "/w" } },
    { label: "a non-string field", value: { path: "/w", branch: "b", baseSha: "abc", workPath: 1, repoPath: "/repo", cwd: "/w" } },
  ])("rejects $label in persisted state", ({ value }) => {
    expect(parseWorktreeResumeState(value)).toBeUndefined();
  });

  describe("verifyWorktreeResume", () => {
    let repoDir: string;
    const pi = mockPi();
    beforeEach(() => { repoDir = initGitRepo(); });
    afterEach(async () => {
      await pruneWorktrees(pi, repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("accepts a registered worktree of the saved repository", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-ok"))!;
      expect(await verifyWorktreeResume(pi, worktreeResumeState(wt, wt.path))).toBeUndefined();
      await cleanupWorktree(pi, repoDir, wt, "verify");
    });

    it("cleans up a verified reopened worktree and preserves its changes on a branch", async () => {
      const original = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
      const wt = (await createWorktree(pi, repoDir, "verify-reopen"))!;
      const saved = worktreeResumeState(wt, wt.path);
      expect(await verifyWorktreeResume(pi, saved)).toBeUndefined();
      writeFileSync(join(wt.path, "reopened.txt"), "reopened work");
      await releaseWorktreeLease(wt);
      const reopened = restoreWorktree(saved, pi);
      await acquireWorktreeLease(reopened);
      const result = await cleanupWorktree(pi, repoDir, reopened, "reopened");
      expect(result).toMatchObject({ hasChanges: true, branch: saved.branch });
      expect(existsSync(wt.path)).toBe(false);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(original);
      expect(execFileSync("git", ["show", `${saved.branch}:reopened.txt`], { cwd: repoDir, encoding: "utf8" })).toBe("reopened work");
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoDir, encoding: "utf8" })).not.toContain(wt.path);
    });

    it("preserves an unreferenced detached commit even when the saved base equals HEAD", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-detached"))!;
      writeFileSync(join(wt.path, "detached.txt"), "unreferenced work");
      execFileSync("git", ["add", "detached.txt"], { cwd: wt.path });
      execFileSync("git", ["commit", "-m", "detached"], { cwd: wt.path, stdio: "pipe" });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, encoding: "utf8" }).trim();
      const saved = worktreeResumeState(wt, wt.path);
      expect(await verifyWorktreeResume(pi, { ...saved, baseSha: head })).toContain("ownership");
      expect(await verifyWorktreeResume(pi, saved)).toBeUndefined();
      await releaseWorktreeLease(wt);
      const reopened = restoreWorktree(saved, pi);
      await acquireWorktreeLease(reopened);
      const result = await cleanupWorktree(pi, repoDir, reopened, "reopened");
      expect(result).toMatchObject({ hasChanges: true, branch: saved.branch });
      expect(execFileSync("git", ["rev-parse", saved.branch], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(head);
      expect(existsSync(wt.path)).toBe(false);
    });

    it("refuses the main checkout", async () => {
      const state = { path: repoDir, branch: "b", baseSha: "abc", ownerToken: "token", workPath: repoDir, repoPath: repoDir, cwd: repoDir };
      expect(await verifyWorktreeResume(pi, state)).toContain("is the main checkout");
    });

    it("refuses a base commit that is not in the worktree history", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-sha"))!;
      const reason = await verifyWorktreeResume(pi, { ...worktreeResumeState(wt, wt.path), baseSha: "0".repeat(40) });
      expect(reason).toContain("Git could not verify");
      await cleanupWorktree(pi, repoDir, wt, "verify");
    });

    it("refuses a removed worktree", async () => {
      const gone = join(repoDir, "gone");
      const state = { path: gone, branch: "b", baseSha: "abc", ownerToken: "token", workPath: gone, repoPath: repoDir, cwd: gone };
      expect(await verifyWorktreeResume(pi, state)).toBe(`its worktree was removed: ${gone}`);
    });

    it("refuses altered ownership metadata and never cleans up the worktree", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-binding"))!;
      const saved = worktreeResumeState(wt, wt.path);
      for (const altered of [
        { ...saved, ownerToken: "wrong" },
        { ...saved, branch: "other-branch" },
        { ...saved, baseSha: "0".repeat(40) },
      ]) {
        expect(await verifyWorktreeResume(pi, altered)).toContain("ownership");
        const result = await cleanupWorktree(pi, repoDir, restoreWorktree(altered, pi), "invalid");
        expect(result.failure).toContain("ownership");
        expect(result.unknownChanges).toBeUndefined();
        expect(existsSync(wt.path)).toBe(true);
      }
      await cleanupWorktree(pi, repoDir, wt, "valid");
    });

    it("refuses an unlocked or attached worktree", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-lock"))!;
      const saved = worktreeResumeState(wt, wt.path);
      execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir });
      expect(await verifyWorktreeResume(pi, saved)).toContain("ownership");
      execFileSync("git", ["switch", "-c", "attached"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["worktree", "lock", "--reason", `pi-agent ${JSON.stringify([wt.ownerToken, wt.baseSha, wt.branch])}`, wt.path], { cwd: repoDir });
      expect(await verifyWorktreeResume(pi, saved)).toContain("ownership");
      expect((await cleanupWorktree(pi, repoDir, wt, "invalid")).failure).toContain("ownership");
      execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir });
      execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    });

    it("refuses a saved directory outside the worktree", async () => {
      const wt = (await createWorktree(pi, repoDir, "verify-outside"))!;
      const reason = await verifyWorktreeResume(pi, worktreeResumeState(wt, repoDir));
      expect(reason).toBe(`its saved directory is outside its worktree: ${repoDir}`);
      await cleanupWorktree(pi, repoDir, wt, "verify");
    });

    it("refuses a directory that Git does not register as a worktree", async () => {
      const plain = mkdtempSync(join(tmpdir(), "pi-wt-plain-"));
      try {
        const reason = await verifyWorktreeResume(pi, worktreeResumeState({ path: plain, branch: "b", baseSha: "abc", ownerToken: "token", workPath: plain, repoPath: repoDir, pi }, plain));
        expect(reason).toBe(`Git does not register ${plain} as a worktree of ${repoDir}`);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it("refuses a worktree registered to another repository", async () => {
      const other = initGitRepo();
      const wt = (await createWorktree(pi, repoDir, "verify-other"))!;
      try {
        const reason = await verifyWorktreeResume(pi, { ...worktreeResumeState(wt, wt.path), repoPath: other });
        expect(reason).toBe(`Git does not register ${wt.path} as a worktree of ${other}`);
      } finally {
        await cleanupWorktree(pi, repoDir, wt, "verify");
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});
