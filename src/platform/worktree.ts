import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETTING_SPECS } from "../config/settings-defaults.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  workPath: string;
  repoPath: string;
  pi: ExtensionAPI;
}

let worktreeIsolationEnabled = SETTING_SPECS.worktreeIsolation.default;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
  path?: string;
  failure?: string;
  unknownChanges?: boolean;
  removalFailure?: string;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  let baseSha: string;
  let subdir: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    const topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000);
    return {
      path: worktreePath,
      branch,
      baseSha,
      workPath: subdir ? join(worktreePath, subdir) : worktreePath,
      repoPath: cwd,
      pi,
    };
  } catch {
    return undefined;
  }
}

export function isWorktreeRetained(worktree: Pick<WorktreeInfo, "path">): boolean {
  return existsSync(worktree.path);
}

export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { hasChanges: true, path: worktree.path, unknownChanges: true };
  }

  try {
    const status = await git(pi, worktree.path, ["status", "--porcelain"], 10000);

    if (status) {
      await git(pi, worktree.path, ["add", "-A"], 10000);
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(pi, worktree.path, ["commit", "--no-verify", "--no-gpg-sign", "-m", commitMsg], 10000);
    } else {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        const removalFailure = await removeWorktree(pi, cwd, worktree.path);
        return removalFailure
          ? { hasChanges: false, path: worktree.path, removalFailure }
          : { hasChanges: false };
      }
    }

    let branchName = worktree.branch;
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
    }
    worktree.branch = branchName;

    const removalFailure = await removeWorktree(pi, cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
      removalFailure,
    };
  } catch (err) {
    return {
      hasChanges: true,
      path: worktree.path,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}

async function removeWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktreePath: string,
): Promise<string | undefined> {
  let failure: string | undefined;
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (failure || existsSync(worktreePath)) {
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000);
    } catch (err) {
      failure ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (!existsSync(worktreePath)) return undefined;
  return failure ?? `git worktree remove and prune left the path \`${worktreePath}\` in place`;
}

export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  await git(pi, cwd, ["worktree", "prune"], 5000).catch(() => {});
}
