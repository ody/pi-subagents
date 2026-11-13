> DRAFT: not accepted, not current truth.

# NNNN. Top-level agents persist their pi sessions by default

## Context

`@handle` can reopen an agent's conversation after its in-memory record is gone. The manager evicts a record roughly ten minutes after it finishes (`src/manager/agent-retention.ts`) and keeps at most 100 tombstones. Only a session file on disk survives that.

`rememberAgents` (default `true`) decides whether a top-level agent writes one. `runAgent` resolves it in `src/session/agent-runner.ts`: the agent file's `persist_session`, else `false` for a nested agent, else `rememberAgents`. The ephemeral agent builder currently sets `persistSession: false`, so an ephemeral agent never persists.

ADR 0019 says `@handle` cannot reopen an evicted inline agent, yet `normalizeInlineAgentConfig` sets no `persistSession`. An inline agent therefore persists under `rememberAgents` today.

## Decision

A top-level agent from an agent file or the `agent` tool with a type persists its session unless told otherwise.

- Precedence: the agent file's `persist_session`, in both directions, then `false` for any nested agent, then `rememberAgents`.
- An ephemeral agent persists like any top-level agent. The ephemeral agents ADR stores its built config on its tombstone, so `@handle` can reopen it, and no parameter overrides this setting.
- An inline RPC definition persists only when its `agentConfig` sets `persistSession: true`.
- A persisted session lives in the agent file's `session_dir`, else `PI_CODING_AGENT_SESSION_DIR`, else pi's configured session directory.
- Its parent is the spawning session, so it shows in that session's `/resume` tree.
- With the setting off, a handle expires with its record and `@handle` starts a fresh agent.
- Persistence writes the pi session file only. It does not cover the `.output` transcript (`outputTranscript`), worktree commits, or memory files.
- The setting applies at spawn time. It does not delete existing session files.

Done check: `npx vitest run test/agent-runner.test.ts test/ephemeral-agent.test.ts test/settings.test.ts` passes. It covers the precedence, nested and inline exclusion, an ephemeral agent persisting under the setting, and the session parent link.

## Consequences

- Every top-level agent run, ephemeral runs included, leaves a file on disk that backup or data-loss tooling will see. Users who do not want that set `rememberAgents: false`.
- Revisit if sessions need a retention limit, since nothing prunes them.
