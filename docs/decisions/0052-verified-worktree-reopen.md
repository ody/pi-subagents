# 0052. Verified worktree reopen

## Context

A persisted agent session can outlive its in-memory record. A worktree-backed session needs its original worktree and its cleanup state.

A forced settle can finish before the run and its tools stop writing. ADR 0033 forbids another `agent:record` entry after late cleanup.

Session history can contain missing, malformed, or obsolete metadata. A path name alone cannot prove isolation or Git ownership.

## Decision

A tombstone reopen proceeds only when the extension can establish the session's isolation state and safe ownership.

- Persist an explicit distinction between non-isolated and worktree-backed sessions. Treat absent or malformed isolation state as unknown.
- Refuse automatic reopen for unknown state. Keep the tombstone and name the reason and any known recovery path.
- For a worktree-backed session, resolve real paths and verify the working directory lies within the original worktree. Verify Git registers that worktree to the expected repository before starting the run or authorizing cleanup.
- Bind each worktree to its owner token, base commit, and branch with a Git worktree lock. Verify the binding at reopen, acquisition, and cleanup. Refuse a missing worktree, inconsistent metadata, or failed validation without changing the worktree.
- Acquire an exclusive lease in the worktree's Git administrative directory before a run. Keep it until cleanup ends. Never break a stale lease automatically.
- Treat the lock and lease as evidence against stale or corrupt records, not as protection from an agent that can modify Git metadata.
- Refuse reopen while an earlier run may still write or clean up the worktree. Preserve that uncertainty across restart when the persisted evidence cannot prove cleanup completed.
- A queued reopen retains its session file, handle, and isolation state in its record. A stopped queued run preserves that recovery state without cleaning up a worktree it never acquired.
- A retained worktree reopen uses ADR 0047's cleanup lifecycle and creates no worktree. ADR 0029's switch cannot grant permission to bypass validation.
- Keep ADR 0033's single-settle and late-cleanup rules. Keep ADR 0050's one shutdown entry per interrupted top-level run.
- Apply ADR 0046 to changes to the `agent:record` contract. The RPC spawn allowlist remains unchanged.

Rejected:

- A path-name heuristic: names do not establish repository identity or prove that a session was not isolated.
- Reopening whenever a directory exists: another run may still write, and the directory may not be the intended worktree.
- Always refusing worktree-backed tombstones: it discards safe recovery of a retained, verified worktree.

Done check: `npm run check` passes. Tests cover valid and invalid Git ownership, path containment, unknown state, forced-settle uncertainty, restart, and queued shutdown. They also cover normal retained-worktree cleanup and removed worktrees.

## Consequences

Verification adds Git calls and can refuse recovery when evidence is unavailable. Some ordinary legacy sessions need manual recovery because they lack explicit isolation state. Older worktree records without an ownership token also need manual recovery.

A forced stop or a process crash can require manual recovery after restart. A crash can leave a lease even when no writer remains. Revisit when pi can prove that stopped tool processes and their cleanup have finished.
