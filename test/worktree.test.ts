import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeIsolationEnabled,
} from "../src/platform/worktree.js";

function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
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

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", async () => {
      const wt = (await createWorktree(pi, repoDir, "clean-1"))!;
      expect(wt).toBeDefined();

      const result = await cleanupWorktree(pi, repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
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

    it("handles already-deleted worktree gracefully", async () => {
      const wt = (await createWorktree(pi, repoDir, "gone-1"))!;
      rmSync(wt.path, { recursive: true, force: true });

      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
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

    it("falls back to pruning when `git worktree remove` fails", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");

      expect(result.hasChanges).toBe(false);
      expect(vi.mocked(failing.exec).mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { }
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

  it("short-circuits when the worktree directory is already gone", async () => {
    const wt = (await createWorktree(pi, repoDir, "vanished"))!;
    expect(wt).toBeDefined();
    rmSync(wt.path, { recursive: true, force: true });

    const result = await cleanupWorktree(pi, repoDir, wt, "agent that vanished");

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
  });

  it("swallows a git failure inside a still-present worktree and reports no changes", async () => {
    const wt = (await createWorktree(pi, repoDir, "corrupt"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent");

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
  });

  it("reports no changes when the preservation commit fails", async () => {
    const wt = (await createWorktree(pi, repoDir, "commit-fails"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(
      failingPi(args => args[0] === "commit", { code: 1, killed: false }),
      repoDir,
      wt,
      "commit fails",
    );

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
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

  it("does not disable createWorktree directly", () => {
    const repoDir = initGitRepo();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = createWorktree(repoDir, "switch-test");
      expect(wt).toBeDefined();
      cleanupWorktree(repoDir, wt!, "switch test");
    } finally {
      pruneWorktrees(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
