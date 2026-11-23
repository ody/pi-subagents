# 0049. Agent handles survive a session switch and a restart

## Context

`@handle` and `agent_get_result` need a live record or a tombstone. The manager belongs to one extension instance, and pi builds a new instance on every session switch, fork, reload, and restart. Session files stay on disk. In-memory tombstones do not outlive their instance.

The `agent:record` session entry is the one durable trace of a top-level agent. It sits on the branch that was active at the settle. Pi advises rebuilding state from `getBranch()`, because abandoned branches are alternative histories. A custom entry never reaches the model. The entry is part of the bus contract (ADR 0044), and an optional field is an additive change (ADR 0046).

Child session files appear under their spawning session in `/resume`. Pi owns session files, and the extension cannot tell which ones a user still wants.

## Decision

Tombstones are a function of the active branch's `agent:record` entries. No record and no tombstone carries over in memory, and the extension never clears state at `session_start` or `session_before_switch`.

Entry shape:

- The entry gains optional `handle`, `alias`, `sessionFile`, `agentConfig`, and `stopCause`. The extension writes `handle`, `alias`, `sessionFile`, and `agentConfig` only when the record has a session file. `agentConfig` is the config of an ephemeral agent (ADR 0023). A registered agent reopens by its type.
- `docs/rpc.md` lists every field except `agentConfig`, which is internal to the extension.

Rebuild:

- On `session_start` and `session_tree`, the manager replaces its tombstones with one per entry on the active branch that has `handle` and `sessionFile`. The key is the handle. Entries with the same id collapse to the later `completedAt`, and so do entries with the same handle.
- A live record with the same handle wins, and the manager drops the tombstone.
- A tombstone carries `status`, `result`, `error`, and `stopCause`. The sweep (ADR 0035) copies them from the record, and the rebuild copies them from the entry.
- `agent_get_result` resolves a tombstone by id, handle, or alias when no record matches. It reports the stored fields as it does for a record, and it consumes nothing. `agent_steer` and `agent_stop` reply "not found" for a tombstone.
- A reopen whose session file is missing keeps the tombstone, and its notification names the path. A reopen follows the worktree rule of ADR 0047.

Retention:

- The extension never prunes child session files (ADR 0027). `rememberAgents: false` writes no handle, session file, or config to the entry.

Rejected:

- Rebuild from every branch: a handle can name an agent from an abandoned branch, and branches can reuse one handle.
- Records that follow their `rootSessionId` across a switch: a record would outlive its session with an open `AgentSession`.
- Pruning session files by age or with the parent: it can delete a session the user wants, and pi gives no hook for parent deletion.

Done check: `npx vitest run test/manager/tombstone-rebuild.test.ts test/manager/agent-retention.test.ts test/triggers/cross-extension-rpc.test.ts` passes. It covers a rebuild from the active branch and again after `session_tree`, handle and id collisions, a live record winning, and `agent_get_result` from a tombstone. It also covers a missing session file.

## Consequences

- With `rememberAgents` on, session files hold each top-level agent's result and the built config of an ephemeral agent.
- A tombstone holds a result string, so memory grows by at most the tombstone cap.
- Child session files accumulate until pi or the user removes them. Revisit if pi publishes a session retention API.
