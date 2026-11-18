# 0045. `agent:rpc:spawn` accepts only allowlisted options

## Context

`SpawnOptions` in `src/manager/agent-spawn.ts` holds internal fields next to caller fields. The internal fields set the owner, depth, config root, resume session file, handle reclaim, and capability verdict. A bus caller that reaches one can forge ownership or replay an arbitrary session file.

New fields join `SpawnOptions` as the manager grows. A field that the bus boundary does not handle on purpose becomes open to every bus caller.

Callers write option names in other spellings, such as the tool parameter `run_in_background` or the frontmatter key `max_turns`. A key that has no effect gives no signal.

## Decision

`agent:rpc:spawn` accepts only the `options` keys in `RPC_SPAWN_OPTIONS` in `src/triggers/cross-extension-rpc.ts`:

`description`, `name`, `agentConfig`, `model`, `maxTurns`, `isolated`, `inheritContext`, `thinkingLevel`, `isBackground`, `isolation`, `cwd`, `signal`, `onSpawned`, `onQueued`, `onCompaction`, `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onAssistantUsage`.

- Any other key fails the request with code `unknown_option`, and `error` names the key. The check runs in the `agent:rpc:spawn` handler before type, model, and policy resolution.
- The set never includes a field that does one of these things:
  - Sets the owner, depth, nesting cap, config root, transcript directory, or resume session file.
  - Sets a handle reclaim, foreground blocking, capability verdict, ephemeral seed, model replacement, or stop cause.
  - Bypasses the concurrency queue, or sets the UI invocation snapshot.
  - Gives out the live `AgentSession`.
- Adding a key is an additive change, and removing one is breaking ([ADR 0046](0046-rpc-versioning-and-error-codes.md)).

Rejected:

- A denylist of internal fields: a new `SpawnOptions` field stays open until someone adds it to the list.
- Dropping unknown keys without an error: a misspelled key runs with defaults.

Done check: `npx vitest run test/triggers/cross-extension-rpc.test.ts` passes. It asserts that each `RPC_SPAWN_OPTIONS` key reaches the manager's `spawn`. It asserts that an unknown key fails with `unknown_option`, and so does each of `parentAgentId`, `rootSessionId`, `resumeSessionFile`, `capability`, `bypassQueue`, `invocation` and `onSessionCreated`.

## Consequences

- A misspelled option fails the spawn, so callers must send only listed keys.
- A caller cannot skip `maxConcurrent`, set UI display data, or hold the agent's session. An extension that needs one of these needs a new, narrower option.
- Revisit if two extensions need the same excluded field, since the need is then real.
