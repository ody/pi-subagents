# Selfdirect Report: Issues 80 to 97

**Status:** COMPLETE
**Date:** 2026-11-13

- [ ] Report Reviewed
- [ ] Feedback Provided

## Task Specification

Work GitHub issues #80 to #97. Commit once per ticket. After the tickets, run an advisor review, apply its feedback, then run `/skill:adr-complies`.

## What Was Done

- Four agents worked clusters in separate worktrees. I merged their branches into `selfdirect/subagents-issues-80-97`.
- Each ticket from #80 to #97 has its own commit. The subject ends with `(#N)`.
- I also did #77, which is outside the range. It blocks #93 and #95, and it absorbs #60. Commit `4c27f36`.
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
- The per-cluster notes are folded in below. The `docs/selfdirect-notes/` directory is deleted. Git history keeps the files.

### Settings cluster (#77, #80, #93 to #97)

- The menu reads the layer files and the defaults table, not runtime state. A value that failed to persist shows only after the next write.
- A failed write applies the single changed value live and emits `persisted: false`.
- `settings_loaded` keeps its old shape. `settings_changed` carries every key with defaults filled.
- The `defaultMaxTurns` default is `0` (unlimited). Row ids equal settings keys, so the old `joinMode` id is gone.
- `ephemeralNesting` writes through `setLayerPolicyKey`. A reset removes a `policy` object that it emptied.
- `r` removes a key even when `sanitize` would drop its value, because it reads the raw file.
- `snapshotSettings`, `saveSettings` and `readProjectPolicyRaw` are removed.

### Model scope cluster (#82, #89, #90)

- `checkModelScope` returns `replace`. `scopeModel` wraps it, and every site shares it.
- The funnel passes `options.model` only after a replacement or for a caller-supplied model. An in-scope file pin stays with `resolveDefaultModel`.
- The funnel records `modelReplaced` on the record, and the RPC reply reads it from there.
- The nested tool now notifies through `ctx.ui?.notify`.

### Ephemeral cluster (#83, #84, #91, #92)

- An inline RPC agent persists only when `persistSession === true`.
- `AgentRecord.agentConfig` sits beside `displayName` and `promptMode`. Those two stay for the badge code.
- `spawnResolved` treats the config as stored values when `options.ephemeral` is set. `spawnTopLevel` still deletes `options.ephemeral`.

### Misc cluster (#81, #85 to #88)

- Unknown-entry discovery runs only when the policy has an entry.
- A new `resolveIsolation` in `src/tool/invocation-config.ts` serves the tool resolver and the funnel.

## Follow-up Interview Outcomes

- **Policy warning** is now a toast through a notify callback set in `agent-start.ts`. The toast is a no-op without `ctx.ui`. A resume does not warn again.
- **Skill discovery** uses a second `DefaultResourceLoader`, so package skills count. Skills that only an extension's `resources_discover` adds stay unknown.
- **`run_in_background` description** is live. A change re-registers the `agent` tool. ADR 0026 gained one line. The applier skips re-registration until the first registration.
- **Viewer `m` key** is session-only. The toast shows only when a command context exists. A later menu write overwrites it.
- **`showSettings`** is a loop. Two tests were added: row lists against the defaults table, and a full-snapshot project file across a tab switch.
- **Complexity** is not refactored. Tickets #100, #101 and #102 track it.
- **No session model** stays as is, on the user's judgment.
- **ADR 0019** keeps the in-place edit.
- **Housekeeping**: I deleted the seven merged `pi-agent-*` branches. The ten older branches and `stash@{0}` remain.
- **Not done**: the RPC worktree-switch end-to-end test.

## Issues Found

- **Low**: Complexity infos on `scopedOptions`, `resolveAgentCall` and `policy-unknown-entries.ts` are tracked in #100, #101 and #102.
- **Low**: No test drives `subagents:rpc:spawn` end to end for the worktree switch (#87).
- **Low**: With no session model, a replaced pin leaves `options.model` unset and the runner uses the pin (#82).

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
  - I pushed nothing. I did not comment on or close any GitHub issue.

## Worklog

- Created branch `selfdirect/subagents-issues-80-97`. Read issues #80 to #97 and #77.
- Launched four worktree agents. They committed per ticket.
- Merged four branches. Resolved conflicts in four files.
- Fixed the lint import order and the `usage-reporting` test.
- Ran the advisor. Applied its feedback. Committed.
- Ran adr-complies. Fixed V1 and S1. Logged U1 to U3.
- Wrote this report.
