> DRAFT: not accepted, not current truth.

# NNNN. An agent's id is its pi session id

## Context

An agent has one conversation, and pi names a conversation by its session id. Pi mints that id with `uuidv7` from `@earendil-works/pi-ai`, so it sorts by creation time and its first 8 characters repeat for about a minute. `SessionManager.create` and `SessionManager.inMemory` accept an explicit `id`. `SessionManager.open` keeps the id in the file header.

The extension needs an id for each agent before its session exists, because a queued run has a record and no session. The id reaches the manager maps, tool results, lifecycle events, the `agent:record` entry, the tombstone, the `.output` transcript name, and the worktree branch and path.

A session file outlives its record, and a reopen runs the same conversation again. The session file name and the `.output` name both contain the agent id, so one value lets a person find either from the other.

## Decision

An agent's id is a uuidv7 that the extension mints at spawn and passes as the id of the agent's pi session.

- `spawnAgent` mints the id with `uuidv7`. `createRunSessionManager` passes it to `SessionManager.create` for a persisted session and to `SessionManager.inMemory` for any other. It never passes it to `SessionManager.open`.
- `AgentRecord.id` equals the session id in the session file header. The extension uses it unchanged as the tombstone `id`, the `id` in lifecycle events and in the `agent:record` entry, the `.output` file name, and the `agentId` field inside it.
- A reopen from a tombstone takes the id from the header of the session file. It passes that id as the internal spawn option `sessionId`, which `RPC_SPAWN_OPTIONS` never lists (ADR 0045). `spawnAgent` throws when `deps.agents` already holds the id.
- A live record shadows a tombstone with the same id.
- A name for people takes the last 8 characters of the id, which are random. `sessionNameFor` uses that short form, and the worktree branch and path use the full id.
- The top-level tools show the full id and accept an id, a handle, or an alias. The nested tools show and accept the full id. No tool accepts a prefix of an id.
- The change bumps `PROTOCOL_VERSION` and resets `features` (ADR 0046), because a reopen reuses an id for a new run. `docs/rpc.md` states that an id is an opaque string in uuidv7 format, that a consumer never parses it, and that a reopen reuses it.

Rejected:

- A separate id in the same format: the agent keeps two ids, and a person cannot find a transcript from a session file.
- A truncated id: it cannot be a session id, and a shorter id collides more often.
- Prefix lookup: it adds a lookup rule and an ambiguity error, and handles already give the model a short name.

Done check: `npx vitest run test/manager/agent-lifecycle.test.ts test/session/agent-runner.test.ts test/triggers/cross-extension-rpc.test.ts test/manager/agent-id.test.ts` passes. It covers an id that equals the session id for a persisted and an in-memory agent, and the header id of the session file. It also covers a reopen that keeps its id and refuses a held id. It checks the short name of two agents started in one minute and the `.output` name. It checks the protocol version in `docs/rpc.md`.

## Consequences

- An id is 36 characters in tool results and on the bus. Handles stay the short form.
- A reopened agent keeps its original id, so a consumer sees that id start a second run.
- pi-advisor ships a matching change with the version bump (ADR 0046).
- Revisit if pi changes its session id format or stops accepting an explicit id in `SessionManager`.
