import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETTING_SPECS } from "../config/settings-defaults.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  ownerToken: string;
  leaseToken?: string;
  workPath: string;
  repoPath: string;
  pi: ExtensionAPI;
}

export interface WorktreeResumeState {
  path: string;
  branch: string;
  baseSha: string;
  ownerToken: string;
  workPath: string;
  repoPath: string;
  cwd: string;
}

const WORKTREE_RESUME_KEYS = ["path", "branch", "baseSha", "ownerToken", "workPath", "repoPath", "cwd"] as const;

export function worktreeResumeState(worktree: WorktreeInfo, cwd: string): WorktreeResumeState {
  return {
    path: worktree.path,
    branch: worktree.branch,
    baseSha: worktree.baseSha,
    ownerToken: worktree.ownerToken,
    workPath: worktree.workPath,
    repoPath: worktree.repoPath,
    cwd,
  };
}

export function restoreWorktree(state: WorktreeResumeState, pi: ExtensionAPI): WorktreeInfo {
  return {
    path: state.path,
    branch: state.branch,
    baseSha: state.baseSha,
    ownerToken: state.ownerToken,
    workPath: state.workPath,
    repoPath: state.repoPath,
    pi,
  };
}

export function parseWorktreeResumeState(value: unknown): WorktreeResumeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  for (const key of WORKTREE_RESUME_KEYS) {
    const field = candidate[key];
    if (typeof field !== "string" || field.length === 0) return undefined;
  }
  return {
    path: candidate.path as string,
    branch: candidate.branch as string,
    baseSha: candidate.baseSha as string,
    ownerToken: candidate.ownerToken as string,
    workPath: candidate.workPath as string,
    repoPath: candidate.repoPath as string,
    cwd: candidate.cwd as string,
  };
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

function lockReason(ownerToken: string, baseSha: string, branch: string): string {
  return `pi-agent ${JSON.stringify([ownerToken, baseSha, branch])}`;
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
  const ownerToken = randomUUID();

  try {
    await git(pi, cwd, ["worktree", "add", "--detach", "--lock", "--reason", lockReason(ownerToken, baseSha, branch), worktreePath, baseSha], 30000);
  } catch {
    return undefined;
  }
  const worktree: WorktreeInfo = {
    path: worktreePath,
    branch,
    baseSha,
    ownerToken,
    workPath: subdir ? join(worktreePath, subdir) : worktreePath,
    repoPath: cwd,
    pi,
  };
  try {
    await acquireWorktreeLease(worktree);
  } catch (err) {
    throw new Error(`Worktree at ${worktreePath} could not acquire a lease and remains on disk: ${err instanceof Error ? err.message : String(err)}`);
  }
  return worktree;
}

export function isWorktreeRetained(worktree: Pick<WorktreeInfo, "path">): boolean {
  return existsSync(worktree.path);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function verifyWorktreeResume(pi: ExtensionAPI, state: WorktreeResumeState): Promise<string | undefined> {
  if (!existsSync(state.path)) return `its worktree was removed: ${state.path}`;
  let path: string;
  let repo: string;
  try {
    path = realpathSync(state.path);
    repo = realpathSync(state.repoPath);
    for (const inner of [state.cwd, state.workPath]) {
      if (!isInside(path, realpathSync(inner))) return `its saved directory is outside its worktree: ${inner}`;
    }
  } catch {
    return `its saved worktree paths do not resolve: ${state.path}`;
  }
  try {
    const listing = await git(pi, repo, ["worktree", "list", "--porcelain", "-z"], 10000);
    const blocks = listing.split("\0\0").map(block => block.split("\0"));
    const listed = blocks.map((block) => {
      const entry = block.find(line => line.startsWith("worktree "));
      try { return entry ? realpathSync(entry.slice(9)) : undefined; } catch { return undefined; }
    });
    if (listed[0] === path) return `${state.path} is the main checkout, not an agent worktree`;
    const index = listed.indexOf(path);
    if (index < 0) return `Git does not register ${state.path} as a worktree of ${state.repoPath}`;
    const block = blocks[index];
    if (!state.ownerToken || !block.includes("detached") ||
      !block.includes(`locked ${lockReason(state.ownerToken, state.baseSha, state.branch)}`)) {
      return `Git could not verify ownership of ${state.path}`;
    }
    await git(pi, path, ["cat-file", "-e", `${state.baseSha}^{commit}`], 5000);
    await git(pi, path, ["merge-base", "--is-ancestor", state.baseSha, "HEAD"], 5000);
    await git(pi, path, ["check-ref-format", "--branch", state.branch], 5000);
  } catch (err) {
    return `Git could not verify ${state.path}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

async function worktreeLeasePath(worktree: WorktreeInfo): Promise<string> {
  const failure = await verifyWorktreeResume(worktree.pi, worktreeResumeState(worktree, worktree.path));
  if (failure) throw new Error(failure);
  const common = realpathSync(await git(worktree.pi, worktree.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5000));
  const admin = realpathSync(await git(worktree.pi, worktree.path, ["rev-parse", "--absolute-git-dir"], 5000));
  const worktrees = realpathSync(join(common, "worktrees"));
  if (worktrees !== join(common, "worktrees") || relative(worktrees, admin).split(sep).length !== 1 ||
    !isInside(worktrees, admin) || admin === worktrees ||
    realpathSync(readFileSync(join(admin, "gitdir"), "utf8").trim()) !== realpathSync(join(worktree.path, ".git"))) {
    throw new Error(`Git could not verify worktree admin directory: ${admin}`);
  }
  return join(admin, "pi-agent-lease");
}

export async function acquireWorktreeLease(worktree: WorktreeInfo): Promise<void> {
  if (worktree.leaseToken) throw new Error(`Worktree already has a lease: ${worktree.path}`);
  const path = await worktreeLeasePath(worktree);
  const token = randomUUID();
  try {
    writeFileSync(path, token, { flag: "wx", mode: 0o600 });
  } catch (err) {
    throw new Error(`Could not acquire worktree lease ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  worktree.leaseToken = token;
}

export async function releaseWorktreeLease(worktree: WorktreeInfo): Promise<void> {
  if (!worktree.leaseToken) throw new Error(`Worktree has no lease token: ${worktree.path}`);
  const path = await worktreeLeasePath(worktree);
  try {
    if (readFileSync(path, "utf8") !== worktree.leaseToken) throw new Error("lease token does not match");
    unlinkSync(path);
  } catch (err) {
    throw new Error(`Could not release worktree lease ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  worktree.leaseToken = undefined;
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

  const ownershipFailure = await verifyWorktreeResume(pi, { ...worktreeResumeState(worktree, worktree.path), workPath: worktree.path });
  if (ownershipFailure) return { hasChanges: true, path: worktree.path, failure: ownershipFailure };

  try {
    const leasePath = await worktreeLeasePath(worktree);
    if (!worktree.leaseToken || readFileSync(leasePath, "utf8") !== worktree.leaseToken) {
      return { hasChanges: true, path: worktree.path, failure: `This run does not hold the worktree lease: ${leasePath}` };
    }
  } catch (err) {
    return { hasChanges: true, path: worktree.path, failure: err instanceof Error ? err.message : String(err) };
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

      const reachable = currentSha === worktree.baseSha
        ? await git(pi, worktree.path, ["for-each-ref", "--contains", currentSha, "--format=%(refname)"], 5000)
        : "";
      if (currentSha === worktree.baseSha && reachable) {
        const removalFailure = await removeWorktree(pi, cwd, worktree);
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
    const removalFailure = await removeWorktree(pi, cwd, worktree);

    return {
      hasChanges: true,
      branch: branchName,
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
  worktree: WorktreeInfo,
): Promise<string | undefined> {
  const failure = await verifyWorktreeResume(pi, { ...worktreeResumeState(worktree, worktree.path), workPath: worktree.path });
  if (failure) return failure;
  try {
    await git(pi, cwd, ["worktree", "unlock", worktree.path], 10000);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  try {
    await git(pi, cwd, ["worktree", "remove", worktree.path], 10000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await git(pi, cwd, ["worktree", "lock", "--reason", lockReason(worktree.ownerToken, worktree.baseSha, worktree.branch), worktree.path], 10000);
    } catch (lockErr) {
      return `${message}; could not restore lock: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`;
    }
    return message;
  }
  return existsSync(worktree.path) ? `git worktree remove left the path \`${worktree.path}\` in place` : undefined;
}

export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  await git(pi, cwd, ["worktree", "prune"], 5000).catch(() => {});
}
