# 0044. The pi.events bus is the only integration surface

## Context

Other extensions drive agents through `pi.events`. pi-advisor (`codeberg.org/ody/pi-advisor`) spawns an inline agent ([ADR 0019](0019-rpc-inline-agent-definitions.md)), waits on `agent:completed` or `agent:failed`, and consumes the result. Names follow [ADR 0043](0043-agent-event-namespace.md).

The bus is in-process, and `emit` dispatches synchronously. A payload can carry function values and an `AbortSignal`.

pi runs every extension factory before it applies an agent's `extensions:` filter. It delivers `session_start` only to the extensions that pass the filter.

A headless host reaches the bus too. pi exports `createEventBus`, and `DefaultResourceLoader` accepts it as `eventBus`. `pi -p` disposes its runtime after the last prompt, and `session_shutdown` stops every running agent.

A process-global object has no version, no reply envelope, and no availability signal. If it returns the live `AgentRecord`, every internal field becomes API.

## Decision

The bus is the only surface that other extensions and hosts use. The surface is `agent:rpc:*` requests, `agent:*` events, and the `agent:record` session entry. Never publish a `globalThis` object, an exported API, or any other side channel for them.

- `docs/rpc.md` is the contract reference. It lists every channel, request and reply field, event and payload field, spawn option, error code, feature name, and `agent:record` field. A contract change and its `docs/rpc.md` change land in one commit.
- The contract is in-process only. Function-valued options and `signal` are part of it, and it promises no serializable form.
- `agent:completed` and `agent:failed` carry `stopCause` when the run stopped.

Availability:

1. Handlers register on every `session_start` that finds them unregistered.
2. `agent:ready` fires next, then `agent:settings_loaded`.
3. `session_shutdown` unregisters the handlers.

Nothing reaches the bus from the extension factory. A session that filters the extension out emits nothing and answers nothing.

Shutdown barrier:

- `agent:rpc:wait_idle` replies `{ success: true }` when no top-level agent waits in the queue or runs.
- It also waits for nested agents, including one that outlives its parent.
- It waits for all top-level agents, not only those of the caller. A run that starts after the reply needs a new request.
- If `session_shutdown` comes first, the reply fails with code `shutdown`.
- It takes no timeout. The caller owns its timeout.

Tests reach agents through the bus or through `AgentManager` directly. No test reads a process global.

Rejected:

- A `globalThis` registry: a second surface with no versioning.
- A narrowed registry that returns snapshots: it still needs its own versioning and documentation.
- A test-only seam: it ships test code in `src/`, and it gives real hosts no barrier.

Done check:

- `npx vitest run test/rpc-contract.test.ts` passes. It asserts that nothing reaches the bus before `session_start`, and that handlers register again after shutdown and a new start. It asserts both `wait_idle` replies. It asserts that every string literal in `src/` that matches `/^agent:[a-z_:]+/` appears in `docs/rpc.md`.
- `git grep -n 'pi-subagents:manager' -- ':!docs/decisions'` prints nothing.

## Consequences

- A caller cannot read a record back. Event payloads must carry what callers need, and a new field is an additive change.
- A headless host that wants background agents to finish must build the bus and send `wait_idle`. Whether `pi -p` itself holds for background agents is a separate decision.
- Revisit if pi adds a typed inter-extension API or runs extensions in separate processes. Function-valued options and the synchronous consume depend on one process.
