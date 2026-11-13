# Selfdirect Report: Issues 80 to 97

**Status:** COMPLETE
**Date:** 2026-11-13

- [ ] Report Reviewed
- [ ] Feedback Provided

## Task Specification

Work GitHub issues #80 to #97. Commit once per ticket. After the tickets, run an advisor review, apply its feedback, then run `/skill:adr-complies`.

## What Was Done

- Four agents worked clusters in separate worktrees. I merged their branches into `selfdirect/subagents-issues-80-97`.
- Every ticket has its own commit with `(#N)` in the subject: #80, #81, #82, #83, #84, #85, #86, #87, #88, #89, #90, #91, #92, #93, #94, #95, #96, #97.
- #77 was done out of range. It blocks #93 and #95, and it absorbs #60. Commit `4c27f36`.
- Advisor feedback applied: the `reportUsage` row index in `test/usage-reporting.test.ts` derives from `SETTING_ROWS`. The `ephemeral` checks in `src/triggers/spawn-funnel.ts` now agree.
- ADR compliance fixes: the `worktreeIsolation` row text says "downgrades" (`src/ui/settings-rows.ts`). ADR 0019 records the `persistSession` default of inline agents.
- `npm run check` exits 0. 110 test files pass.

## Decisions Made

- **Decision**: Do #77 although it is outside 80 to 97.
  - **Alternatives considered**: Skip #93 and #95.
  - **Rationale**: Both tickets name #77 as a blocker.
  - **Risk**: Low.
  - **Reversible**: Yes, revert `4c27f36`.
- **Decision**: Use worktree-isolated parallel agents in four clusters (settings, model scope, ephemeral, misc).
  - **Alternatives considered**: One serial pass.
  - **Rationale**: Faster. The conflicts were small.
  - **Risk**: Low.
  - **Reversible**: Not applicable.
- **Decision**: Resolve merge conflicts by combining both sides.
  - `src/triggers/spawn-funnel.ts` keeps the ephemeral `capabilityFor` call plus the `resolveIsolation` line.
  - `src/tool/nested-tools.ts` keeps `modelReplacedNote`, `scopeModel` and `SETTING_SPECS`.
  - `test/capability-policy-config.test.ts` keeps both import sets and drops the removed `saveSettings`.
  - `README.md` keeps the unknown-entry policy bullet and drops the obsolete "saving writes policy back" bullet.
  - **Risk**: Low. The full suite passes.
- **Decision**: Keep `docs/selfdirect-notes/` in the repo.
  - **Rationale**: The notes hold per-ticket design decisions that this report only summarizes.
  - **Reversible**: Yes, delete the directory.
- **Decision**: Fix the `test/usage-reporting.test.ts` mock for the new menu. The fake theme gets `fg` and `bold`, and the custom mock answers once. The menu now reloops on REFRESH.
  - **Risk**: Low.
- Per-cluster decisions are in `docs/selfdirect-notes/{settings,modelscope,ephemeral,misc}.md`.

## Issues Found

- **Low**: `src/triggers/spawn-funnel.ts:36` `scopedOptions` has complexity 27 (Biome info, not an error). `agent-call-resolution.ts:121` and `policy-unknown-entries.ts:23` are also over the info threshold. Refactor later.
- **Low**: A skill that comes only from a pi package is not in the default skill directories. A policy entry that names it gets a false warning (#81).
- **Low**: Row value lists in `src/ui/settings-rows.ts` repeat allowed values from the defaults table. No test ties them (#80).
- **Low**: No test covers a project file that holds a full snapshot across a tab switch (#95).
- **Low**: No test drives `subagents:rpc:spawn` end to end for the worktree switch (#87).
- **Low**: With no session model, a replaced pin leaves `options.model` unset and the runner uses the pin (#82).
- **Low**: `showSettings` recurses on each tab or refresh. Not changed.

## Needs Your Review

- **Unrecorded decisions from adr-complies (confidence 45 to 55)**. Candidates for ADRs:
  - The unknown-policy-entry warning goes out as a `policy-warning:` tool activity at agent start.
  - The `run_in_background` description follows the startup setting, not live changes (ADR 0026 says "applies live").
  - The viewer `m` key writes the project layer.
- I edited accepted ADR 0019. The change adds one sentence about `persistSession`.
- A live menu change to `backgroundByDefault` updates the tool description only after restart.
- Housekeeping I did not do:
  - Leftover `pi-agent-*` branches and worktrees remain.
  - `stash@{0}` predates this run (based on `764e7c7`). I did not create or touch it.
  - Nothing is pushed. No GitHub issue is commented or closed.

## Worklog

- Created branch `selfdirect/subagents-issues-80-97`. Read issues #80 to #97 and #77.
- Launched four worktree agents. They committed per ticket.
- Merged four branches. Resolved conflicts in four files.
- Fixed the lint import order and the `usage-reporting` test.
- Ran the advisor. Applied its feedback. Committed.
- Ran adr-complies. Fixed V1 and S1. Logged U1 to U3.
- Wrote this report.
