# Selfdirect Report: Backlog triage and worktree reopen

**Status:** COMPLETE for #165 implementation; review remains
**Date:** 2026-11-23

- [ ] Report Reviewed
- [ ] Feedback Provided

## Task Specification

Research the backlog, delegate work to `deepseek-v4.1-flash-fast`, request advisor review, and fix obvious defects. Leave non-obvious choices for discussion.

## Completed Work

- Delegated #165 to the subagent. It persisted worktree resume state and reopened retained worktrees.
- Interviewed you and accepted the result as [ADR 0052](../decisions/0052-verified-worktree-reopen.md). `AGENTS.md` now indexes it.
- Implemented ADR 0052:
  - `agent:record` entries carry `isolation` (`none` or `worktree`) and `cleanupPending`.
  - `verifyWorktreeResume` checks real paths, Git registration, base ancestry, and a Git lock that binds the owner token, base commit, and branch.
  - `reopenRefusal` in `src/triggers/mention-input.ts` fails closed on unknown, inconsistent, or invalid state, and on pending cleanup.
  - A queued reopen record carries its session file and worktree state from creation.
- Replaced the path-name heuristic. Removed its stale wording from ADRs 0047 and 0049 and `README.md`. Documented the new fields in `docs/rpc.md`.
- Advisor reviews identified ownership, queue, cleanup, and restart risks. The implementation revalidates at acquisition and cleanup, and keeps uncertain worktrees.
- An exclusive Git administrative-directory lease prevents two processes from running in the same worktree. The extension never breaks a stale lease automatically.
- Tests cover forced settlement, restart, queued shutdown, retained-worktree cleanup, lease contention, and ownership mismatch.
- `npm run check` passed: 3,016 tests passed and 4 skipped. `npm run test:e2e` passed: 59 tests passed and 4 skipped.

## Decisions Made

- **Decision:** Fix #165 rather than start #154 budgets. **Risk:** Medium. **Reversible:** Yes, discard the branch.
- **Decision:** Fail closed for entries without an `isolation` marker. **Risk:** Medium. Existing ordinary legacy sessions no longer reopen automatically.
- **Decision:** Refuse reopen whenever an entry carries `cleanupPending`. A forced-settle or shutdown entry keeps it because late cleanup writes no second entry (ADR 0033). The entry can therefore require manual recovery after restart.
- **Decision:** Added `isolation` and `cleanupPending` under the existing `agent_record_worktree` feature name instead of a second feature. **Risk:** Low, because no release contains the branch.

## Issues Found

- **Medium:** Crash recovery can require manual removal of a stale lease. Confirm no process or tool still uses the worktree before removing it.
- **Medium:** Cleanup refuses an attached worktree or a HEAD outside the saved base history. It keeps the worktree for manual recovery.
- **Medium:** I extended accepted ADRs 0029, 0047, and 0049 in place. Confirm that is acceptable beside the new ADR.
- **Low:** #154 and #114 need work. See below.
- **Low:** The untracked `pi-session-2026-11-21T06-14-28-790Z_01a1fcbd-f0b6-7338-aa33-5b0948e7031e.html` predates this work and stays untouched.

## Needs Your Review

- Review the branch diff before merging. The work has a local commit and no push.
- Review the lifecycle tests and safety audit before merging.
- #154: you chose to defer budgets until this lands, then draft an ADR. `src/tool/nested-tools.ts:233` already rolls child usage into ancestors, so fleet accounting must avoid double counting.
- Backlog audit: you chose an audit with proposals and no GitHub changes. A read-only check found code for #157, #161, and #162, and the main changes for #163 and #164. It found evidence for #158 and #160 but did not verify their full scope. #114 names removed FleetView and old RPC names. I did not propose or file edits, because the GitHub tools became unavailable.

## Next Steps

1. Review the diff and ADR 0052.
2. Audit tickets #157, #158, and #160–#165 and propose closures. Close #165 only after merge.
3. Interview #154 and draft its ADR.

## Worklog

- Triaged the backlog and delegated #165.
- Interviewed you and accepted ADR 0052.
- Implemented validation, pending-cleanup tracking, queued state, and tests.
- Ran advisor reviews and fixed the verified safety defects.
- Added a cross-process lease and lifecycle tests.
- Kept a queued resume's prior result for recovery without showing it as the stopped run's output.
