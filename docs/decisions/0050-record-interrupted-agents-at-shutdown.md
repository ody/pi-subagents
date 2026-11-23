# 0050. A shutdown records the agents it interrupts

## Context

A top-level agent that is running or queued when pi shuts down leaves no `agent:record` entry, so the session history has no sign it existed. Pi fires `session_shutdown` before it tears the runtime down, for cleanup and saving state. It fires for a switch, a fork, and a reload as well as a quit, and the entry lands in the session that pi leaves.

`abortAll` stops runs without settling them (ADR 0033). A stopped run's promise can still resolve and reach its settle callback, which appends an entry. Two writers for one run would break the single ending that ADR 0033 requires.

A queued run has no session file. A running run has one only when it persists (ADR 0027). Tombstone rebuild reads `handle` and `sessionFile` from the entry, so only a run with a session file can reopen.

## Decision

On `session_shutdown`, each running or queued top-level agent gets one `agent:record` entry with status `stopped` and `stopCause: "shutdown"`.

- The entry carries `handle`, `alias`, `sessionFile`, and `agentConfig` on the same terms as any other entry, and a queued run has no session file to carry.
- A run stopped with cause `shutdown` writes no entry when it settles late. The shutdown write is the one entry written outside `settleRun`.
- The shutdown write emits no lifecycle event and sends no notification. `abortAll` still does not settle (ADR 0033).
- Only top-level records write it (ADR 0007).

Rejected:

- Dropping interrupted runs: the history has holes, and the user cannot tell a run existed.
- Offering to resume interrupted runs at start: it needs a start prompt and worktree reconciliation (ADR 0047), so it is its own decision.

Done check: `npx vitest run test/manager/shutdown-record.test.ts test/manager/agent-lifecycle.test.ts` passes. It covers a running and a queued agent at shutdown. It also covers no entry from a nested agent, no event, and no notification. A stopped run that settles late writes no second entry.

## Consequences

- A reopened shutdown tombstone follows the worktree rule of ADR 0047, and a queued run cannot reopen.
- The write depends on pi flushing `appendEntry` during `session_shutdown`. Revisit if it stops.
- ADR 0033 needs a one-line carve-out for this entry.
