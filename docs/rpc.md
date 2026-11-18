# Driving subagents from another extension

Another pi extension can spawn a subagent, listen for subagent completion, read the result and stop the run. It does all of this over the `pi.events` bus, without importing this package directly. Five request/reply channels (`agent:rpc:ping`, `agent:rpc:spawn`, `agent:rpc:stop`, `agent:rpc:consume`, `agent:rpc:wait_idle`), and nine lifecycle events.

The thing worth understanding up front is that **the bus is in-process.** Every "RPC" call here is a synchronous `pi.events.emit` into the same event loop, and every reply comes back the same way. That single fact explains most of what follows:

- Why `signal` and the `on*` callbacks work on a spawn payload at all.
- Why a `consume` fired inside a `agent:completed` handler lands *before* the notifier decides whether to notify.
- Why none of this survives a real process boundary.

This document is the contract reference ([ADR 0044](decisions/0044-bus-only-integration-surface.md)). For the per-channel snippets, see [`README.md`](../README.md#cross-extension-rpc). This document covers:

- Every event, its payload, and the session names.
- The complete spawn-option surface.
- Every error code.
- The notification race.
- What protocol version `3` does and does not promise.

## Spawn options

`agent:rpc:spawn` accepts only the keys in `RPC_SPAWN_OPTIONS` (`src/triggers/cross-extension-rpc.ts`). Any other key in `options` fails the spawn with `unknown_option`, and the error text names the key. The check runs before type, model and policy resolution, so nothing spawns. The spawn funnel in `src/triggers/spawn-funnel.ts` then resolves the type, model scope, capability verdict and isolation.

The full interface is `SpawnOptions` in `src/manager/agent-spawn.ts`. Internal keys are not in the list: `parentAgentId`, `depth`, `maxSubagentDepth`, `configCwd`, `rootSessionId`, `resumeSessionFile`, `reclaim`, `blocking`, `capability`, `ephemeral`, `modelReplaced`, `signalCause`, `bypassQueue`, `invocation` and `onSessionCreated`. Tool and frontmatter spellings fail too, such as `run_in_background`, `max_turns`, `thinking` and `inherit_context`. Use `isBackground`, `maxTurns`, `thinkingLevel` and `inheritContext`.

| Field | Type | Notes |
| --- | --- | --- |
| `description` | string | What the agent is doing. Shown in the widget and the completion notification |
| `agentConfig` | `Partial<AgentConfig>` with `systemPrompt` | Runs this definition instead of the registered `type`. See [Inline agent definitions](#inline-agent-definitions) |
| `name` | string | A memorable second handle (`@auth-audit`). Slugged, never validated — anything unusable degrades rather than failing the spawn |
| `model` | `Model` **or** `"provider/modelId"` | The spawn funnel resolves strings against `ctx.modelRegistry`. `null` means inherit, not override. Resolution is fuzzy — see [Model Scope](../README.md#model-scope) |
| `maxTurns` | number | Turn ceiling for the run |
| `isolated` | boolean | Strips extensions, skills and nested tools. **Not** a git worktree; use `isolation` for that |
| `inheritContext` | boolean | Fork the parent conversation into the child |
| `thinkingLevel` | ThinkingLevel | Clamped to what the resolved model supports |
| `isBackground` | boolean | Occupies a `maxConcurrent` slot and queues behind them. Every RPC spawn runs detached regardless; this is what decides whether the manager *pools* it |
| `isolation` | `"worktree"` | Temp git worktree, committed to a `pi-agent-*` branch on completion |
| `cwd` | absolute path | The agent's tools operate here; `.pi` config still loads from the parent session's project |
| `signal` | AbortSignal | Aborting it stops the subagent |
| `onSpawned` / `onQueued` / `onCompaction` | functions | Fire as documented on `SpawnOptions` |
| `onToolActivity` / `onTextDelta` / `onTurnEnd` / `onAssistantUsage` | functions | Run after the manager's own bookkeeping. They do not replace it (`startAgent` in `src/manager/agent-start.ts`) |

**Capability policy.** The spawn funnel runs `checkCapabilityPolicy` itself. A caller cannot supply a `capability` verdict.

The RPC handler passes the raw `agentConfig` next to the normalized one. The policy check refuses a field the caller wrote when the field is outside the policy. It filters a field the boundary defaulted (`extensions`, `skills`).

The spawn reply is `{ id, filtered?, modelReplaced? }`, where `filtered` lists what the policy removed from an agent file's values, such as `tool bash`.

**Model scope.** `modelReplaced` is the out-of-scope model, such as `anthropic/claude-opus-4-6`, that the scope check replaced with the session model. It appears only after a replacement. A caller-supplied out-of-scope `model` still fails the spawn with the allowed list.

Two things that are not obvious from the table:

- **The runtime requires nothing.** `description` is non-optional in TypeScript and never validated. A spawn with no `options` at all is legal and works because the RPC handler and `spawnTopLevel` both substitute `{}`.
- **`signal` and the `on*` callbacks are function values.** They work only because the bus is in-process. A caller that genuinely serializes its payload cannot use them, and they arrive as `undefined` rather than failing.

### Inline agent definitions

`options.agentConfig` lets an extension ship its agent with the spawn instead of installing an agent file. The definition applies to that one run. The registry never stores it, so the `agent` tool and `/agents` never offer it.

The shape is `AgentConfig` from `src/types.ts`, using its field names rather than frontmatter spellings. The RPC boundary completes it:

- `systemPrompt` must be present.
- `name` is always set to `type`, which names the run (handle, session name, record) and is never resolved against the registry.
- `description` defaults to `options.description`, then `type`.
- `extensions` and `skills` default to `true`, and `promptMode` to `"replace"`, like omitted frontmatter.
- `builtinToolNames` omitted means all built-ins. `[]` means none.

A no-tool agent with no extensions or skills:

```typescript
pi.events.emit("agent:rpc:spawn", {
  requestId,
  type: "advisor",
  prompt: renderedTranscript,
  options: {
    description: "Advisor review",
    agentConfig: {
      systemPrompt: "You review another agent's work.",
      builtinToolNames: [],
      extensions: false,
      skills: false,
    },
  },
});
```

Three things to know:

- **An inline agent does not persist by default.** It writes a session to disk only when its `agentConfig` sets `persistSession: true`. `rememberAgents` does not apply to it.
- **UI surfaces show a generic name.** The widget and the conversation viewer look display names up by type, so an inline agent renders under a generic name next to its `description`.
- **`@handle` cannot reopen an evicted inline agent.** Reopening resolves the type against the registry and refuses when no agent has that name. If a registered agent has the same name, `@handle` reopens that agent instead, so pick a type no agent file uses. A live record whose session still exists resumes normally, under the tools it started with.

## Errors

Every failure reaches the caller as `{ success: false, code, error }` (`handleRpc` in `src/triggers/cross-extension-rpc.ts`). Branch on `code`. The `error` text is for people and is not contract: it can change in any release.

`code` is one of the values below, from `RPC_ERROR_CODES` in `src/rpc-error.ts`. Anything thrown without a code maps to `internal`.

| Code | Cause |
| --- | --- |
| `no_session` | The request came before the first bound `session_start`, or the session has no context |
| `model_registry_unavailable` | The caller sent a `model` override but `ctx.modelRegistry` is missing |
| `invalid_agent_config` | Inline `agentConfig` is not an object, has no string `systemPrompt`, or has an empty or non-string `type` |
| `unknown_type` | `type` does not resolve to exactly one enabled agent, or is empty, and the caller gave no `agentConfig` |
| `unknown_option` | `options` has a key outside the allowed list. The error text names the key |
| `model_not_found` | A string `model` matches no model in the registry |
| `model_out_of_scope` | `scopeModels` is on and the caller's `model` is outside `enabledModels`. The check uses the *resolved* model |
| `policy_denied` | A tool, extension, or skill is outside the [capability policy](../README.md#capability-policy), or the policy files have problems. Nothing spawns |
| `invalid_cwd` | `options.cwd` is not an absolute path, does not exist, or is not a directory |
| `worktree_failed` | The caller set `isolation: "worktree"`, and the repository has no commits, is not a git repository, or `git worktree add` failed |
| `not_found` | `stop` or `consume` names no agent this caller may use |
| `not_owned` | `stop` names a nested agent that another agent owns |
| `not_running` | `stop` names an agent that has already settled |
| `still_running` | `consume` names an agent that is running or queued |
| `shutdown` | `wait_idle` was pending when `session_shutdown` came |
| `internal` | Any other failure, such as a spawn that reached the manager without a policy verdict |

**The in-session `agent_stop` tool diverges from this on the already-settled case.** Both resolve to the same `manager.abort()` call and the same `isTopLevelAgent` ownership check. For a record that has already settled, the RPC channel replies with code `not_running`. The tool reports its terminal status as a normal (non-error) result.

The model's intent — "that agent should not be running" — is already true, and an `isError: true` result is the wrong signal for "nothing to do". An extension, by contrast, can and should branch on an error envelope.

Don't mirror the tool's wording back into the RPC reply, or a caller that branches on `not_running` silently stops seeing it.

Three things the table cannot show:

- **The failure that is not an error.** With `worktreeIsolation` off project-wide, the spawn funnel and `src/manager/agent-start.ts` drop `isolation: "worktree"`. They raise no error and leave no note on the record. The wire carries a success envelope. Your agent runs in the main tree. If you asked for isolation because two agents were going to write the same files, they now collide and nothing told you.
- **A handler that returns nothing omits `data`**, so a successful stop or consume reply is a bare `{ success: true }` and `reply.data.anything` throws.
- **A request without a `requestId` gets no reply.** The id must be a non-empty string, because it names the reply channel. The extension silently drops a request that fails this check. Send a unique one.

## Ownership

`isTopLevelAgent(record)` is `parentAgentId === undefined` (`isTopLevelAgent` in `src/manager/agent-manager-rules.ts`). `agent:rpc:stop` enforces it (`src/triggers/cross-extension-rpc.ts`): a nested child has an owner that is *waiting on it*. Aborting the child out from under that owner turns another extension's stop into a failed step. It is defence in depth rather than a live hole. No RPC hands out agent ids, so a caller has no ordinary way to name an agent it does not own.

One asymmetry to know about, stated as it is:

- **Stop takes an id only** (`agent:rpc:stop` in `src/triggers/cross-extension-rpc.ts`). Consume takes an id *or* an `@handle`, through `consumeResult` in `src/index.ts`, which calls `resolveAgentRef` from `src/triggers/spawn-funnel.ts`.

The same predicate silently scopes the events. **Every lifecycle event is top-level only** — `agent:started`, `:completed`, `:failed` and `:compacted` all return early for nested agents (`src/index.ts`). A nested child is invisible on the bus: you will see its parent come and go without a single event for the child.

### Stop and the settle tail

**Stop fires the abort signal and arms a grace timer.** `manager.abort(id, "extension")` — the same call this channel makes — aborts the run, sets `record.stopCause` to `extension` and arms a 5s timer. The same cause applies when a `signal` you pass to `agent:rpc:spawn` aborts.

Every run settles exactly once, through one tail. The tail detaches the parent abort signal and flushes the output file. It stops nested children and releases the pool slot. Then it fires the completion callback.

A run that resolves enters the tail itself. A wedged run enters the same tail when the timer fires, so a `agent:rpc:stop` call frees its slot and fires `agent:completed`/`:failed` within a few seconds. A later real settle returns at once and fires nothing.

A stopped run's `agent:failed` payload carries `stopCause`. Other payloads omit the field.

A stop while the run waits in the queue, or during worktree creation, enters the same tail. It fires `agent:failed` once, with status `stopped`.

A start that fails enters the same tail with status `error`. It fires `agent:failed` once and appends one `agent:record` entry. A direct start also rethrows to its caller.

The forced entry copies the streamed response text into `record.result` when no result exists. That event and the notification then carry the partial output instead of an empty `result`. The forced entry also adds the worktree path when the run has a worktree. Nothing about the reply envelope changes — `stop` still replies before the settle tail runs, forced or otherwise.

## The notification race

When a background agent finishes, pi-subagents sends the user a completion notification. If you have already shown the model that result yourself, the notification arrives on top of an answer the model already has. It costs the parent a turn to dismiss. `agent:rpc:consume` is how you say you have handled it — the bus-side half of what `agent_get_result` does when it returns a result.

**When you send it decides whether it works.** The timeline:

1. The agent settles and the settle callback of `AgentManager` in `src/index.ts` emits `agent:completed`.
2. In the same callback, `notifier.onAgentComplete` (`src/manager/completion-notifier.ts`) checks `record.resultConsumed` and decides whether to notify at all.
3. `pi.events` dispatch is synchronous and in-process, so a handler that emits `agent:rpc:consume` **without awaiting anything** has already set that flag before step 2 evaluates.

| When you consume | What happens |
| --- | --- |
| Synchronously, inside your `agent:completed` handler | The notification is never scheduled. This is the clean path |
| After an `await`, within 200 ms | Still suppressed. The notifier holds the nudge for `NUDGE_HOLD_MS` (`src/manager/completion-notifier.ts`), `consumeResult` in `src/index.ts` calls `cancelNudge`, and `emitIndividualNudge` re-checks `resultConsumed` at send time |
| After 200 ms | Too late. The follow-up has fired with `triggerTurn: true` and cost the parent a turn |

Fire-and-forget is the intended use. The reply carries nothing to act on. The channel sits outside the `agent:rpc:ping` version handshake on purpose (`registerRpcHandlers` in `src/triggers/cross-extension-rpc.ts`). You can send it unconditionally, because an older pi-subagents with no handler simply keeps notifying.

Consumption is not terminal. A resume, foreground or background, un-consumes the record (`resume` in `src/manager/agent-resume.ts` sets `record.resultConsumed = false`) because the record is starting a new run. Only a new run clears consumption: an `@handle` steer of a running or queued agent leaves it unchanged.

One related thing that lives nowhere else: on every top-level settle, pi-subagents writes a session entry — not an event — via `pi.appendEntry("agent:record", …)`. The call sits in the settle callback of `AgentManager` in `src/index.ts`. The entry carries `id`, `type`, `description`, `status`, `result`, `error`, `startedAt` and `completedAt`. It exists for cross-extension history reconstruction. It is append-only history, not something to react to.

## Events

The extension emits these events on `pi.events`. The four agent-lifecycle events (`agent:started`, `agent:completed`, `agent:failed`, `agent:compacted`) fire for top-level agents only.

| Event | When | Payload fields |
| --- | --- | --- |
| `agent:created` | `agent`-tool background spawn, or a detached resume. Not an RPC or `@handle` spawn | `id`, `type`, `description`, `isBackground` |
| `agent:started` | The agent starts to run, also from the queue | `id`, `type`, `description` |
| `agent:completed` | The agent finished | `id`, `type`, `description`, `status`, `result`, `error`, `durationMs`, `tokens`, `usage`, `toolUses`, `stopCause` (stopped runs only) |
| `agent:failed` | The agent errored, stopped, or aborted, also from the queue or at start | Same fields as `agent:completed` |
| `agent:steered` | The extension accepted a steer, delivered or queued | `id`, `message` |
| `agent:compacted` | The agent's session compacted | `id`, `type`, `description`, `reason`, `tokensBefore`, `compactionCount` |
| `agent:ready` | The RPC handlers registered on `session_start` | `{}` |
| `agent:settings_loaded` | Right after `agent:ready` | `settings`, `policy` (see [Settings events](#settings-events)) |
| `agent:settings_changed` | A `/agents` setting change or reset | `settings`, `persisted`, `layer`, `policy` |

The extension also writes two session names. Neither goes on the bus:

- `agent:record` is a custom session entry (see [The notification race](#the-notification-race)).
- `agent:notification` is the custom message type of a completion notification.

## Wait idle

`agent:rpc:wait_idle` takes only a `requestId`. It replies `{ success: true }` once no top-level agent (`isTopLevelAgent`) waits in the queue or runs. It covers every top-level agent, not only the caller's. A run that starts after the reply needs a new request. It has no timeout parameter: give the wait your own timer. When `session_shutdown` comes first, it replies `{ success: false, code: "shutdown", error }`.

## Protocol versions

`agent:rpc:ping` replies `{ version, features, policy }`. `version` is `PROTOCOL_VERSION` in `src/triggers/cross-extension-rpc.ts`, currently `3`. `features` is `RPC_FEATURES` in the same file, currently `[]`. The rules for breaking and additive changes are in [ADR 0046](decisions/0046-rpc-versioning-and-error-codes.md).

Version 3 contains these breaks against version 2:

- Every channel, event and session entry name uses the `agent:` prefix.
- Every failure reply carries a `code` from the closed set in this document.
- A spawn payload accepts only the options in the spawn-option allowlist.
- Version 3 has no global agent registry.
- `agent:rpc:wait_idle` exists.
- `stopCause` is part of the stop flow.
- `agent:settings_loaded` fires on `session_start`, right after `agent:ready`, and not from the extension factory.

The feature list resets to `[]` on each version bump. Version 3 has no additive feature yet.

`policy` is `{ global, project, ephemeralNesting }`: each file's `allow` and `deny` lists for `tools`, `extensions`, and `skills`, and the merged `ephemeralNesting`. The ping reads it from disk every time, so it is the only copy that is always current. When the policy files have problems, it carries a `malformed` list of problems and the manager denies every spawn. `agent:settings_loaded` and `agent:settings_changed` carry the same object under `policy`, but a hand edit of `subagents.json` fires neither.

## Settings events

`agent:settings_loaded` fires on every `session_start` that registers the RPC handlers, right after `agent:ready`. It never fires from the extension factory, and a session that excludes pi-subagents never emits it. The extension applies settings at factory time and reads the files again at `session_start` for the payload. The payload is `{ settings, policy }`, where `settings` is the merged global and project file, with only the keys the files set.

`agent:settings_changed` fires when the `/agents` menu changes or resets a setting, including `policy.ephemeralNesting`. Its payload is `{ settings, persisted, layer, policy }`:

| Field | Meaning |
| --- | --- |
| `settings` | The effective settings, recomputed from both files and the defaults. Every `SubagentsSettings` key is present. |
| `persisted` | `false` when the write failed, so the change holds for this session only. |
| `layer` | `"global"` or `"project"`, the layer the change wrote to. |
| `policy` | `{ global, project, ephemeralNesting }`, as in the ping reply. |

A global change that the project overrides still fires the event, with `layer: "global"` and an effective `settings` that did not change.

## Availability

`agent:ready` is the discovery signal, and the `session_start` handler in `src/index.ts` wires both the RPC handlers and the event itself on each `session_start` that finds them unregistered. `agent:settings_loaded` follows `agent:ready` in the same handler. It does not do this at factory time, on purpose. pi runs every extension factory *before* it applies an agent's `extensions:` filter. It only delivers lifecycle events to the survivors. A factory-time broadcast made a filtered-out session advertise a spawn service it could never provide: `ping` succeeded and every `spawn` answered `No active session`.

The consequence is worth stating plainly: **a session that excludes pi-subagents is indistinguishable from a system that lacks pi-subagents.** It emits no `agent:ready` and answers nothing. Give discovery a timeout and treat expiry as "not available here" rather than waiting indefinitely. The payload is `{}` — read nothing off it. Handlers are torn down and the flag reset on `session_shutdown` (the `session_shutdown` handler in `src/index.ts`), so a later `session_start` re-registers and re-emits.

One more trap on the way in: an RPC-spawned agent emits **no `agent:created`**. The only two emit sites are the `agent` tool's background branch (`src/tool/agent-tool-background.ts`) and detached resume (`src/manager/background-resume.ts`). Your first event for your own agent is `agent:started` (the start callback of `AgentManager` in `src/index.ts`), so key your bookkeeping off the id that `spawn` handed you, not off `agent:created`.

## What the tests pin

This document has no test of its own, so it is worth knowing which claims are actually held in place:

| Test | Level | Pins |
| --- | --- | --- |
| `test/triggers/cross-extension-rpc.test.ts` | Mocked `SpawnCapable` | Envelope shape, per-channel error codes, `requestId` validation, model resolution and scope enforcement |
| `test/rpc-contract.test.ts` | Real extension factory | No bus emission before `session_start`; `agent:ready` before `agent:settings_loaded`; handlers register again after `session_shutdown`; both `wait_idle` replies; every `agent:` literal in `src/` appears in this document |
| `test/rpc-lifecycle-gating.test.ts` | Real extension factory | Nothing wired at factory time, everything once at `session_start`, and live widget activity for RPC spawns |
| `test/rpc-result-consumption.test.ts` | Real delivery path | The notification firing, and not firing, around `consume` |
| `test/rpc-inline-agent.test.ts` | Real extension factory | An inline `agentConfig` skips type resolution, reaches `runAgent`, and stays out of the registry |
| `test/queued-stop-events.test.ts` | Real extension factory | A `agent:rpc:stop` of a queued run fires `agent:failed` once and appends one `agent:record` entry |

Not pinned anywhere, so treat them as descriptions rather than contracts: the `error` texts, `agent:ready`'s `{}` payload, and consume's handle resolution.

## Reference implementation

[**`ody/pi-advisor`**](https://codeberg.org/ody/pi-advisor) is the working integration (`src/backend.ts`). It drives `agent:rpc:spawn` with an inline `agentConfig` and a `"provider/modelId"` string `model`. It waits on `agent:completed` and `agent:failed`, and it calls `agent:rpc:consume` to report the result itself.

Read it for the shape of the whole loop:

- Wait on `agent:ready`.
- Keep an id-keyed map of outstanding spawns.
- Resolve each from the `agent:completed` / `agent:failed` handler.
- Consume the result in the same synchronous handler that reports it.
