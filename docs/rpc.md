# Driving subagents from another extension

Another pi extension can spawn a subagent, listen for subagent completion, read the result and stop the run. It does all of this over the `pi.events` bus, without importing this package directly. Four request/reply channels (`agent:rpc:ping`, `agent:rpc:spawn`, `agent:rpc:stop`, `agent:rpc:consume`), nine lifecycle events, and one in-process registry at `Symbol.for("pi-subagents:manager")`.

The thing worth understanding up front is that **the bus is in-process.** Every "RPC" call here is a synchronous `pi.events.emit` into the same event loop, and every reply comes back the same way. That single fact explains most of what follows:

- Why `signal` and the `on*` callbacks work on a spawn payload at all.
- Why a `consume` fired inside a `agent:completed` handler lands *before* the notifier decides whether to notify.
- Why none of this survives a real process boundary.

For the channel list, the reply envelope, the per-channel snippets and the event table, see [`README.md`](../README.md#cross-extension-rpc). This document is the reference for what the README has no room for:

- The complete spawn-option surface.
- Every error string.
- The notification race.
- The registry.
- What protocol version `2` does and does not promise.

## Spawn options

`agent:rpc:spawn` forwards `options` to `AgentManager.spawn` — but not verbatim. The manager's `spawn` behind the RPC is `spawnTopLevel` in `src/triggers/spawn-funnel.ts`, which deletes internal-only fields first. Then `spawnResolved` in the same file resolves the type, model scope, capability verdict and isolation. The full interface is `SpawnOptions` in `src/manager/agent-spawn.ts`; what a bus caller actually gets is three different things.

**Honoured** — set these and they take effect:

| Field | Type | Notes |
| --- | --- | --- |
| `description` | string | What the agent is doing. Shown in the widget and the completion notification |
| `agentConfig` | `Partial<AgentConfig>` with `systemPrompt` | Runs this definition instead of the registered `type`. See [Inline agent definitions](#inline-agent-definitions) |
| `name` | string | A memorable second handle (`@auth-audit`). Slugged, never validated — anything unusable degrades rather than failing the spawn |
| `model` | `Model` **or** `"provider/modelId"` | The RPC boundary resolves strings against `ctx.modelRegistry`. `null` means inherit, not override. Resolution is fuzzy — see [Model Scope](../README.md#model-scope) |
| `maxTurns` | number | Turn ceiling for the run |
| `isolated` | boolean | Strips extensions, skills and nested tools. **Not** a git worktree — see the trap table below |
| `inheritContext` | boolean | Fork the parent conversation into the child |
| `thinkingLevel` | ThinkingLevel | Clamped to what the resolved model supports |
| `isBackground` | boolean | Occupies a `maxConcurrent` slot and queues behind them. Every RPC spawn runs detached regardless; this is what decides whether the manager *pools* it |
| `bypassQueue` | boolean | Starts immediately even when the concurrency limit would queue it. The slot is still counted once running |
| `isolation` | `"worktree"` | Temp git worktree, committed to a `pi-agent-*` branch on completion |
| `cwd` | absolute path | The agent's tools operate here; `.pi` config still loads from the parent session's project |
| `invocation` | AgentInvocation | Resolved snapshot used for UI display |
| `signal` | AbortSignal | Aborting it stops the subagent |
| `onSpawned` / `onQueued` / `onCompaction` | functions | Fire as documented on `SpawnOptions` |

**Silently stripped** — set these and nothing happens, with no error and no note. Each deletion is a deliberate guard, and the reasons are worth knowing because they say what the surface refuses to let a caller forge:

| Field | Why the guard removes it |
| --- | --- |
| `parentAgentId` | Ownership. A forged parent hides your agent under someone else's nested tools |
| `depth`, `maxSubagentDepth` | A child inherits the nesting cap; the caller does not declare it |
| `configCwd` | Config-discovery root; only nested launches may set it |
| `rootSessionId` | Names a transcript directory, so a forged value is a path-traversal primitive |
| `resumeSessionFile` | Worse: it names a file to **open and replay** as a conversation. Dispatcher only, and only from a path this extension itself recorded |
| `reclaim` | Bypasses handle allocation, so a forged value would duplicate a live agent's name and make `@handle` ambiguous |
| `blocking` | Every spawn through here runs detached. A forged `blocking` would charge it to the foreground pool and defer it behind a queue whose gate nobody is holding |

**Chained** — `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onSessionCreated` and `onAssistantUsage` do not replace the manager's own callbacks. `startAgent` in `src/manager/agent-start.ts` runs its activity and usage bookkeeping first, then calls yours. Every programmatic spawn passes through one funnel, so the manager's bookkeeping always runs.

**Capability policy.** `spawnTopLevel` also deletes a `capability` verdict a caller supplies, then runs `checkCapabilityPolicy` itself.

The RPC handler passes the raw `agentConfig` next to the normalized one. The policy check refuses a field the caller wrote when the field is outside the policy. It filters a field the boundary defaulted (`extensions`, `skills`). The registry `spawn` never normalizes, so every field of its `agentConfig` counts as supplied.

The spawn reply is `{ id, filtered?, modelReplaced? }`, where `filtered` lists what the policy removed from an agent file's values, such as `tool bash`.

**Model scope.** `modelReplaced` is the out-of-scope model, such as `anthropic/claude-opus-4-6`, that the scope check replaced with the session model. It appears only after a replacement, and `PROTOCOL_VERSION` stays `2`. A caller-supplied out-of-scope `model` still fails the spawn with the allowed list.

Three things that are not obvious from the tables:

- **The runtime requires nothing.** `description` is non-optional in TypeScript and never validated. A spawn with no `options` at all is legal and works because the RPC handler and `spawnTopLevel` both substitute `{}`.
- **`bypassQueue` is not stripped.** A bus caller can set it and skip the `maxConcurrent` check.
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

### Names that look right and are not

One of these already shipped as a bug in this project's own README example. Read the table even if you are sure.

| You might write | What it does | What you meant |
| --- | --- | --- |
| `run_in_background` | Forwarded verbatim and ignored — it is the [`agent`](../README.md#agent) *tool's* parameter name | `isBackground` |
| `isolated: true` | Disables extensions, skills and nested tools | `isolation: "worktree"` for a git worktree |
| `isolation: "worktree"` | Creates a git worktree | `isolated: true` to strip capabilities |
| `configCwd` | Stripped | `cwd` |
| `max_turns` / `thinking` / `inherit_context` | Ignored — tool and frontmatter spellings | `maxTurns` / `thinkingLevel` / `inheritContext` |

**None of these produce an error.** This path does not validate option keys at all — it accepts and drops unknown ones.

## Errors

Every failure reaches the caller as `{ success: false, error }`, where `error` is `err?.message ?? String(err)` (`handleRpc` in `src/triggers/cross-extension-rpc.ts`) — so these strings are what you will actually see.

| Error | Source |
| --- | --- |
| `No active session` | `registerRpcHandlers` in `src/triggers/cross-extension-rpc.ts` — called before the first bound `session_start`, or in a session that excludes pi-subagents |
| `Model override "<label>" provided but ctx.modelRegistry is unavailable` | `registerRpcHandlers` in `src/triggers/cross-extension-rpc.ts` |
| `Inline agentConfig requires a systemPrompt string` | `normalizeInlineAgentConfig` in `src/triggers/cross-extension-rpc.ts` — `agentConfig` is not an object, or has no string `systemPrompt` |
| `Inline agentConfig requires a type to name the run` | `normalizeInlineAgentConfig` in `src/triggers/cross-extension-rpc.ts` — `agentConfig` set with an empty or non-string `type` |
| `Capability policy: <value and list>` | `src/config/capability-policy.ts` — a tool, extension, or skill in `agentConfig` is outside the [capability policy](../README.md#capability-policy), or the policy files have problems. Nothing spawns |
| `Capability policy: a spawn needs a verdict from checkCapabilityPolicy.` | `src/manager/agent-spawn.ts` — a spawn reached the manager without a verdict. Not reachable from the bus or the registry |
| `Model not found: "<input>".` + available models | `resolveModel` in `src/config/model-resolver.ts` |
| `Model not in scope: "<input>".` + allowed models | `checkModelScope` in `src/config/model-scope.ts` — only with `scopeModels` on, and checked against the *resolved* model |
| `Unknown or disabled agent type: "<raw>". Available: <list>.` | `src/agents/agent-types.ts` — `type` does not resolve to exactly one enabled agent, and the caller gave no `agentConfig` |
| `No agent type given. Available: <list>.` | `src/agents/agent-types.ts` — `type` is empty and the caller gave no `agentConfig` |
| `SpawnOptions.cwd must be an absolute path: "<value>"` | `assertValidSpawnCwd` in `src/manager/agent-manager-rules.ts` |
| `SpawnOptions.cwd does not exist: "<cwd>"` | `assertValidSpawnCwd` in `src/manager/agent-manager-rules.ts` |
| `SpawnOptions.cwd is not a directory: "<cwd>"` | `assertValidSpawnCwd` in `src/manager/agent-manager-rules.ts` |
| `Cannot run with isolation: "worktree" — not a git repo, no commits yet, or 'git worktree add' failed.` | `startAgent` in `src/manager/agent-start.ts`, surfaced through `awaitStartup` |
| git plumbing failures | `git` helper in `src/platform/worktree.ts` |
| `Agent not found` | stop — `agent:rpc:stop` handler in `src/triggers/cross-extension-rpc.ts` |
| `Agent is owned by another agent` | stop — same handler |
| `Agent is not running` | stop — same handler. The record exists, so it has already settled |
| `Agent not found or still running` | consume — `agent:rpc:consume` handler in the same file |

**The in-session `agent_stop` tool diverges from this on the already-settled case.** Both resolve to the same `manager.abort()` call and the same `isTopLevelAgent` ownership check. For a record that has already settled, the RPC channel throws `Agent is not running`. The tool reports its terminal status as a normal (non-error) result.

The model's intent — "that agent should not be running" — is already true, and an `isError: true` result is the wrong signal for "nothing to do". An extension, by contrast, can and should branch on an error envelope.

Don't mirror the tool's wording back into the RPC error string, or a caller that pattern-matches on `Agent is not running` silently stops seeing it.

Three things the table cannot show:

- **The failure that is not an error.** With `worktreeIsolation` off project-wide, the spawn funnel and `src/manager/agent-start.ts` drop `isolation: "worktree"`. They raise no error and leave no note on the record. The wire carries a success envelope. Your agent runs in the main tree. If you asked for isolation because two agents were going to write the same files, they now collide and nothing told you.
- **A handler that returns nothing omits `data`**, so a successful stop or consume reply is a bare `{ success: true }` and `reply.data.anything` throws.
- **`requestId` is not validated.** Nothing checks it, and the value goes straight into the reply channel name. A caller that omits it gets its reply on the literal channel `agent:rpc:spawn:reply:undefined`. Every other caller that omitted it also listens there. Send one, and send a unique one.

## Ownership

`isTopLevelAgent(record)` is `parentAgentId === undefined` (`isTopLevelAgent` in `src/manager/agent-manager-rules.ts`). `agent:rpc:stop` enforces it (`src/triggers/cross-extension-rpc.ts`): a nested child has an owner that is *waiting on it*. Aborting the child out from under that owner turns another extension's stop into a failed step. It is defence in depth rather than a live hole. No RPC hands out agent ids, so a caller has no ordinary way to name an agent it does not own.

One asymmetry to know about, stated as it is:

- **Stop takes an id only** (`agent:rpc:stop` in `src/triggers/cross-extension-rpc.ts`). Consume takes an id *or* an `@handle`, through `consumeResult` in `src/index.ts`, which calls `resolveAgentRef` from `src/triggers/spawn-funnel.ts`.

The same predicate silently scopes the events. **Every lifecycle event is top-level only** — `agent:started`, `:completed`, `:failed` and `:compacted` all return early for nested agents (`src/index.ts`). A nested child is invisible on the bus: you will see its parent come and go without a single event for the child.

### Stop and the settle tail

**Stop fires the abort signal and arms a grace timer.** `manager.abort(id, "extension")` — the same call this channel makes — aborts the run, sets `record.stopCause` to `extension` and arms a 5s timer. The same cause applies when a `signal` you pass to `agent:rpc:spawn` aborts.

Every run settles exactly once, through one tail. The tail detaches the parent abort signal and flushes the output file. It stops nested children and releases the pool slot. Then it fires the completion callback.

A run that resolves enters the tail itself. A wedged run enters the same tail when the timer fires, so a `agent:rpc:stop` call frees its slot and fires `agent:completed`/`:failed` within a few seconds. A later real settle returns at once and fires nothing.

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

## The manager registry

`globalThis[Symbol.for("pi-subagents:manager")]` (`MANAGER_KEY` and `registryEntry` in `src/index.ts`) is a second integration surface — the standard Node cross-package singleton pattern, no bus involved:

| Member | Signature | Notes |
| --- | --- | --- |
| `waitForAll()` | `() => Promise<void>` | Resolves when nothing is running. **All** agents, including ones you did not spawn — a shutdown barrier, not a join |
| `hasRunning()` | `() => boolean` | |
| `spawn(pi, ctx, type, prompt, options)` | `=> string` | **Is** `spawnTopLevel`, so the strip list above applies identically |
| `getRecord(id)` | `=> AgentRecord \| undefined` | Filtered through `isTopLevelAgent`, so someone else's child comes back `undefined` rather than leaking. A `stopped` record carries `stopCause`: `user`, `agent`, `extension`, `owner` or `shutdown`. An aborted spawn `signal` from the registry gives `extension` |

Only the first activation claims the slot. Subagent sessions re-activate this extension in the same process. An unconditional overwrite would point the registry at a short-lived child manager, and that manager's shutdown would delete the root session's entry. Child activations leave the slot alone. Shutdown releases it only if this activation claimed it (`ownsManagerRegistry` and the `session_shutdown` handler in `src/index.ts`).

Prefer the bus. The registry has no reply envelope, no version, and no availability event. The only probe you get is `globalThis[Symbol.for("pi-subagents:manager")] === undefined`. It is also `undefined` in a session that filtered pi-subagents out. Use the registry for two things the bus has no verb for: *is anything still running*, and *give me a settled record back*. A headless host can also use it to block on `waitForAll()` before exiting.

## Protocol versions

`agent:rpc:ping` replies `{ version: PROTOCOL_VERSION, policy }`, currently `2` (`PROTOCOL_VERSION` in `src/triggers/cross-extension-rpc.ts`). 0.5.0 introduced the constant already equal to `2`. "v1" is a retroactive name for the pre-envelope contract:

- Spawn replied with a bare `{ id }` or `{ error }`.
- Stop replied `{ success: boolean }` with no message.
- Each handler caught its own errors.

`policy` is `{ global, project, ephemeralNesting }`: each file's `allow` and `deny` lists for `tools`, `extensions`, and `skills`, and the merged `ephemeralNesting`. The ping reads it from disk every time, so it is the only copy that is always current. When the policy files have problems, it carries a `malformed` list of problems and the manager denies every spawn. `agent:settings_loaded` and `agent:settings_changed` carry the same object under `policy`, but a hand edit of `subagents.json` fires neither.

## Settings events

`agent:settings_loaded` fires on every `session_start` that registers the RPC handlers, right after `agent:ready`. It never fires from the extension factory, and a session that excludes pi-subagents never emits it. Settings are applied at factory time; the payload is read from the files again at `session_start`. Its payload is `{ settings, policy }`, where `settings` is the merged global and project file, with only the keys the files set.

`agent:settings_changed` fires when the `/agents` menu changes or resets a setting, including `policy.ephemeralNesting`. Its payload is `{ settings, persisted, layer, policy }`:

| Field | Meaning |
| --- | --- |
| `settings` | The effective settings, recomputed from both files and the defaults. Every `SubagentsSettings` key is present. |
| `persisted` | `false` when the write failed, so the change holds for this session only. |
| `layer` | `"global"` or `"project"`, the layer the change wrote to. |
| `policy` | `{ global, project, ephemeralNesting }`, as in the ping reply. |

A global change that the project overrides still fires the event, with `layer: "global"` and an effective `settings` that did not change. `PROTOCOL_VERSION` stays `2`.

Everything added since shipped **without a bump**, because all of it is additive: stop's ownership refusal, string-`model` resolution, `scopeModels` enforcement, and the whole `consume` channel.

> A `ping` that answers `2` does not tell you whether `consume` exists, whether the manager enforces model scope, or whether stop checks ownership.

So send `consume` unconditionally and ignore the outcome. An older build has no handler and simply keeps notifying. That is exactly why `consume` sits outside the handshake. Treat every error envelope as authoritative rather than trying to predict which checks are in force.

## Availability

`agent:ready` is the discovery signal, and the `session_start` handler in `src/index.ts` wires both the RPC handlers and the event itself on each `session_start` that finds them unregistered. `agent:settings_loaded` follows `agent:ready` in the same handler. It does not do this at factory time, on purpose. pi runs every extension factory *before* it applies an agent's `extensions:` filter. It only delivers lifecycle events to the survivors. A factory-time broadcast made a filtered-out session advertise a spawn service it could never provide: `ping` succeeded and every `spawn` answered `No active session`.

The consequence is worth stating plainly: **a session that excludes pi-subagents is indistinguishable from a system that lacks pi-subagents.** It emits no `agent:ready` and answers nothing. Give discovery a timeout and treat expiry as "not available here" rather than waiting indefinitely. The payload is `{}` — read nothing off it. Handlers are torn down and the flag reset on `session_shutdown` (the `session_shutdown` handler in `src/index.ts`), so a later `session_start` re-registers and re-emits.

One more trap on the way in: an RPC-spawned agent emits **no `agent:created`**. The only two emit sites are the `agent` tool's background branch (`src/tool/agent-tool-background.ts`) and detached resume (`src/manager/background-resume.ts`). Your first event for your own agent is `agent:started` (the start callback of `AgentManager` in `src/index.ts`), so key your bookkeeping off the id that `spawn` handed you, not off `agent:created`.

## What the tests pin

This document has no test of its own, so it is worth knowing which claims are actually held in place:

| Test | Level | Pins |
| --- | --- | --- |
| `test/cross-extension-rpc.test.ts` | Mocked `SpawnCapable` | Envelope shape, per-channel error strings, model resolution and scope enforcement |
| `test/rpc-contract.test.ts` | Real extension factory | No bus emission before `session_start`; `agent:ready` before `agent:settings_loaded`; handlers register again after `session_shutdown` |
| `test/rpc-lifecycle-gating.test.ts` | Real extension factory | Nothing wired at factory time, everything once at `session_start`, and live widget activity for RPC spawns |
| `test/rpc-result-consumption.test.ts` | Real delivery path | The notification firing, and not firing, around `consume` |
| `test/rpc-inline-agent.test.ts` | Real extension factory | An inline `agentConfig` skips type resolution, reaches `runAgent`, and stays out of the registry |
| `test/queued-stop-events.test.ts` | Real extension factory | A `agent:rpc:stop` of a queued run fires `agent:failed` once and appends one `agent:record` entry |

Not pinned anywhere, so treat them as descriptions rather than contracts: the `SpawnOptions.cwd` error strings, `agent:ready`'s `{}` payload, and consume's handle resolution.

## Reference implementation

[**`tintinweb/pi-tasks`**](https://github.com/tintinweb/pi-tasks) is the working integration, and it shaped this surface. Its `TaskExecute` drives `agent:rpc:spawn`, including the serialized `"provider/modelId"` string form that the boundary now resolves. Its `TaskOutput` drives `agent:rpc:consume`. That channel exists because pi-tasks joins an agent on `agent:completed` and reports the result itself ([pi-tasks#62](https://github.com/tintinweb/pi-tasks/issues/62)).

Read it for the shape of the whole loop:

- Wait on `agent:ready`.
- Keep an id-keyed map of outstanding spawns.
- Resolve each from the `agent:completed` / `agent:failed` handler.
- Consume the result in the same synchronous handler that reports it.
