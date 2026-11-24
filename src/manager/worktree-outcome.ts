import { cleanupWorktree, isWorktreeRetained, releaseWorktreeLease, type WorktreeCleanupResult } from "../platform/worktree.js";
import type { AgentRecord } from "../types.js";

export async function cleanupWorktreeOutcome(record: AgentRecord, description: string): Promise<void> {
  const worktree = record.worktree;
  if (!worktree) return;
  let outcome: WorktreeCleanupResult;
  try {
    outcome = await cleanupWorktree(worktree.pi, worktree.repoPath, worktree, description);
  } catch (err) {
    outcome = {
      hasChanges: true,
      path: worktree.path,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
  if (worktree.leaseToken && isWorktreeRetained(worktree)) {
    try {
      await releaseWorktreeLease(worktree);
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      outcome.failure = outcome.failure ? `${outcome.failure}; ${failure}` : failure;
      outcome.path = worktree.path;
    }
  }
  applyWorktreeOutcome(record, outcome, worktree.repoPath);
}

export function applyWorktreeOutcome(record: AgentRecord, outcome: WorktreeCleanupResult, repoPath: string): void {
  record.worktreeResult = outcome;
  const note = worktreeNote(outcome, repoPath);
  if (note) record.result = (record.result ?? "") + note;
}

function worktreeNote(outcome: WorktreeCleanupResult, repoPath: string): string | undefined {
  const parts: string[] = [];
  if (outcome.unknownChanges) {
    parts.push(
      `The worktree at \`${outcome.path}\` no longer exists. Its change state is unknown. Its changes are not saved to a branch.`,
    );
  }
  if (outcome.failure) {
    parts.push(
      `Saving the worktree changes failed: ${outcome.failure}\nThe worktree stays at \`${outcome.path}\`. Its changes are not on a branch.`,
    );
  }
  if (outcome.branch) {
    parts.push(
      `Changes saved to branch \`${outcome.branch}\` in \`${repoPath}\`. Merge with: \`git merge ${outcome.branch}\` (run in \`${repoPath}\`).`,
    );
  }
  if (outcome.removalFailure) {
    const kept = outcome.branch ? ` Its changes are safe on branch \`${outcome.branch}\`.` : "";
    parts.push(`The worktree at \`${outcome.path}\` could not be removed: ${outcome.removalFailure}.${kept}`);
  }
  return parts.length ? `\n\n---\n${parts.join("\n\n")}` : undefined;
}
