# 0047. pi-subagents owns its worktree lifecycle

## Context

Worktree isolation keeps an agent's edits out of the main checkout and returns finished work on a branch. A run can end with uncommitted edits or with its own commits.

Creation, preservation, and removal share repository paths, the base SHA, branch state, and cleanup outcomes. Their ordering determines whether agent work survives.

`git status --porcelain` and `git add -A` exclude ignored files. Those files can contain dependencies, build output, or secrets that do not belong in a preservation commit.

A forced settle can deliver a result before the agent's run promise resolves (ADR 0033). Cleanup after that boundary needs a result rule that preserves the single-settle guarantee.

A resumed session retains its original working directory. A retained worktree supports recovery, but a removed worktree does not.

## Decision

`src/platform/worktree.ts` owns worktree creation, preservation, and removal whenever isolation applies under ADR 0029. It also owns the lifecycle of retained-path resumes. It runs Git through `pi.exec`.

- Preservation covers tracked edits and non-ignored untracked files. Ignored files are disposable.
- A preservation branch references the worktree HEAD after any preservation commit. Branch creation precedes removal.
- A preservation failure leaves the worktree in place and reports its path and the error.
- A missing worktree path produces an unknown-changes outcome and names that path. It never produces `hasChanges: false`.
- After removal and prune, a remaining worktree produces a removal error and its path. That error does not change the branch or `hasChanges` outcome.
- One result writer stores `worktreeResult` and appends branch, failure, and path outcomes to `record.result`. It covers normal completion, early stop, and run failure.
- An unexpected cleanup exception produces `hasChanges: true`, the worktree path, and the error through that writer.
- After a forced settle, late cleanup updates `record.result` and `worktreeResult` without another settle, lifecycle event, or notification (ADR 0033).
- Resume requires the original retained worktree path. That resumed run uses the same cleanup lifecycle. The extension refuses resume after successful removal.

Rejected:

- A pi worktree extension: cleanup ordering, shared state, and failure guarantees would depend on another extension's contract and release cycle.
- The worktrunk `wt` CLI: most of `cleanupWorktree` remains necessary. The CLI adds a backend dependency without removing the preservation logic.
- Removing worktree isolation: agents lose isolated working copies and separate branch handoff.

Done check: `npx vitest run test/platform/worktree.test.ts test/manager/agent-lifecycle.test.ts test/abort-forced-settle.test.ts test/e2e/worktree-isolation-e2e.test.ts` passes. Coverage includes preservation scope, cleanup failures, all result paths, retained-path resume, late cleanup, and spawn integration.

## Consequences

Local ownership requires direct maintenance of Git behavior and real-Git tests. It keeps preservation and failure handling independent of another extension's release cycle.

A forced-settle notification describes the state at stop time. The record can gain a final worktree outcome later, but no second notification starts a turn.

Ignored files disappear with successful removal. Resume after successful removal requires a different agent run.

Revisit when a pi extension publishes a programmatic worktree API with work-preserving teardown, including creation, preserved branches, retained paths, and failure reporting.
