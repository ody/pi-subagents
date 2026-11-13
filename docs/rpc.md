# Driving subagents from another extension

Another pi extension can spawn a subagent, listen for subagent completion, read the result and stop the run — all over the `pi.events` bus, without importing this package directly. Four request/reply channels (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`), eleven lifecycle events, and one in-process registry at `Symbol.for("pi-subagents:manager")`.

The thing worth understanding up front is that **the bus is in-process.** Every "RPC" call here is a synchronous `pi.events.emit` into the same event loop, and every reply comes back the same way. That single fact explains most of what follows: why `signal` and the `on*` callbacks work on a spawn payload at all, why a `consume` fired inside a `subagents:completed` handler lands *before* the notification decision has been made, and why none of this survives a real process boundary.

For the channel list, the reply envelope, the per-channel snippets and the event table, see [`README.md`](../README.md#cross-extension-rpc). This document is the reference README does not have room for: the complete spawn-option surface, every error string, the notification race, the registry, and what protocol version `2` does and does not promise.

## Spawn options

`subagents:rpc:spawn` forwards `options` to `AgentManager.spawn` — but not verbatim. The manager's `spawn` behind the RPC is `spawnTopLevel` (`src/index.ts:698-721`), which deletes internal-only fields first, and then `spawnResolved` (`src/index.ts:666-696`) overwrites the activity-tracker callbacks with its own. The full interface is `SpawnOptions` at `src/manager/agent-spawn.ts:17-127`; what a bus caller actually gets is three different things.

**Honoured** — set these and they take effect:

| Field | Type | Notes |
| --- | --- | --- |
| `description` | string | What the agent is doing. Shown in the widget, FleetView and the completion notification |
| `agentConfig` | `Partial<AgentConfig>` with `systemPrompt` | Runs this definition instead of the registered `type`. See [Inline agent definitions](#inline-agent-definitions) |
| `name` | string | A memorable second handle (`@auth-audit`). Slugged, never validated — anything unusable degrades rather than failing the spawn |
| `model` | `Model` **or** `"provider/modelId"` | Strings are resolved at the RPC boundary against `ctx.modelRegistry`. `null` means inherit, not override. Resolution is fuzzy — see [Model Scope](../README.md#model-scope) |
| `maxTurns` | number | Turn ceiling for the run |
| `isolated` | boolean | Strips extensions, skills and nested tools. **Not** a git worktree — see the trap table below |
| `inheritContext` | boolean | Fork the parent conversation into the child |
| `thinkingLevel` | ThinkingLevel | Clamped to what the resolved model supports |
| `isBackground` | boolean | Occupies a `maxConcurrent` slot and queues behind them. Every RPC spawn runs detached regardless; this is what decides whether it is *pooled* |
| `bypassQueue` | boolean | Starts immediately even when the concurrency limit would queue it. The slot is still counted once running |
| `isolation` | `"worktree"` | Temp git worktree, committed to a `pi-agent-*` branch on completion |
| `cwd` | absolute path | The agent's tools operate here; `.pi` config still loads from the parent session's project |
| `invocation` | AgentInvocation | Resolved snapshot used for UI display |
| `signal` | AbortSignal | Aborting it stops the subagent |
| `onSpawned` / `onQueued` / `onCompaction` | functions | Fire as documented on `SpawnOptions` |

**Silently stripped** — set these and nothing happens, with no error and no note. Each deletion is a deliberate guard, and the reasons are worth knowing because they say what the surface refuses to let a caller forge:

| Field | Why it is taken away |
| --- | --- |
| `parentAgentId` | Ownership. A forged parent hides your agent under someone else's nested tools |
| `depth`, `maxSubagentDepth` | The nesting cap is inherited, not declared |
| `configCwd` | Config-discovery root; only nested launches may set it |
| `rootSessionId` | Names a transcript directory, so a forged value is a path-traversal primitive |
| `resumeSessionFile` | Worse: it names a file to **open and replay** as a conversation. Dispatcher only, and only from a path this extension itself recorded |
| `reclaim` | Bypasses handle allocation, so a forged value would duplicate a live agent's name and make `@handle` ambiguous |
| `blocking` | Every spawn through here is detached. A forged `blocking` would charge it to the foreground pool and defer it behind a queue whose gate nobody is holding |

**Silently overwritten** — `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onSessionCreated` and `onAssistantUsage` are replaced by the activity tracker's own (`src/index.ts:693`). Every programmatic spawn passes through one funnel so none can supply half-wired callbacks; a half-wired tracker renders worse than none, which is the bug behind a row that reads `thinking…` for an agent's whole life.

**Capability policy.** `spawnTopLevel` also deletes a `capability` verdict a caller supplies, then runs `checkCapabilityPolicy` itself. The RPC handler passes the raw `agentConfig` next to the normalized one, so a field the caller wrote is refused when it is outside the policy, and a field the boundary defaulted (`extensions`, `skills`) is filtered. The registry `spawn` never normalizes, so every field of its `agentConfig` counts as supplied. The spawn reply is `{ id, filtered?, modelReplaced? }`, where `filtered` lists what the policy removed from an agent file's values, such as `tool bash`.

**Model scope.** `modelReplaced` is the out-of-scope model, such as `anthropic/claude-opus-4-6`, that the scope check replaced with the session model. It appears only after a replacement, and `PROTOCOL_VERSION` stays `2`. A caller-supplied out-of-scope `model` still fails the spawn with the allowed list.

Three things that are not obvious from the tables:

- **Nothing is required at runtime.** `description` is non-optional in TypeScript and never validated. A spawn with no `options` at all is legal and is what `test/cross-extension-rpc.test.ts:81-94` pins.
- **`bypassQueue` is not stripped.** A bus caller can set it and skip the `maxConcurrent` check.
- **`signal` and the `on*` callbacks are function values.** They work only because the bus is in-process. A caller that genuinely serializes its payload cannot use them, and they arrive as `undefined` rather than failing.

### Inline agent definitions

`options.agentConfig` lets an extension ship its agent with the spawn instead of installing an agent file. The definition is used for that one run and is never added to the registry, so the `agent` tool and `/agents` never offer it.

The shape is `AgentConfig` from `src/types.ts`, using its field names rather than frontmatter spellings. The RPC boundary completes it:

- `systemPrompt` is required.
- `name` is always set to `type`, which names the run (handle, session name, record) and is never resolved against the registry.
- `description` defaults to `options.description`, then `type`.
- `extensions` and `skills` default to `true`, and `promptMode` to `"replace"`, like omitted frontmatter.
- `builtinToolNames` omitted means all built-ins. `[]` means none.

A no-tool agent with no extensions or skills:

```typescript
pi.events.emit("subagents:rpc:spawn", {
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
- **UI surfaces show a generic name.** The widget, FleetView and the conversation viewer look display names up by type, so an inline agent renders under a generic name next to its `description`.
- **An evicted inline agent cannot be reopened by `@handle`.** Reopening resolves the type against the registry and refuses when nothing is registered under that name. A registered agent with the same name would be reopened instead, so pick a type no agent file uses. A live record whose session still exists resumes normally, under the tools it was created with.

### Names that look right and are not

One of these already shipped as a bug in this project's own README example, so it is worth reading the table even if you are sure.

| You might write | What it does | What you meant |
| --- | --- | --- |
| `run_in_background` | Forwarded verbatim and ignored — it is the [`agent`](../README.md#agent) *tool's* parameter name | `isBackground` |
| `isolated: true` | Disables extensions, skills and nested tools | `isolation: "worktree"` for a git worktree |
| `isolation: "worktree"` | Creates a git worktree | `isolated: true` to strip capabilities |
| `configCwd` | Stripped | `cwd` |
| `max_turns` / `thinking` / `inherit_context` | Ignored — tool and frontmatter spellings | `maxTurns` / `thinkingLevel` / `inheritContext` |

**None of these produce an error.** Option keys are not validated on this path at all — unknown ones are accepted and dropped.

## Errors

Every failure reaches the caller as `{ success: false, error }`, where `error` is `err?.message ?? String(err)` (`src/triggers/cross-extension-rpc.ts:110`) — so these strings are what you will actually see.

| Error | Source |
| --- | --- |
| `No active session` | `src/triggers/cross-extension-rpc.ts:130` — called before the first bound `session_start`, or in a session that excludes pi-subagents |
| `Model override "<label>" provided but ctx.modelRegistry is unavailable` | `src/triggers/cross-extension-rpc.ts:149` |
| `Inline agentConfig requires a systemPrompt string` | `src/triggers/cross-extension-rpc.ts:79` — `agentConfig` is not an object, or has no string `systemPrompt` |
| `Inline agentConfig requires a type to name the run` | `src/triggers/cross-extension-rpc.ts:76` — `agentConfig` set with an empty or non-string `type` |
| `Capability policy: <value and list>` | `src/config/capability-policy.ts` — a tool, extension, or skill in `agentConfig` is outside the [capability policy](../README.md#capability-policy), or the policy is malformed. Nothing spawns |
| `Capability policy: a spawn needs a verdict from checkCapabilityPolicy.` | `src/manager/agent-spawn.ts` — a spawn reached the manager without a verdict. Not reachable from the bus or the registry |
| `Model not found: "<input>".` + available models | `src/config/model-resolver.ts:125` |
| `Model not in scope: "<input>".` + allowed models | `src/config/model-scope.ts:62` — only with `scopeModels` on, and checked against the *resolved* model |
| `Unknown or disabled agent type: "<raw>". Available: <list>.` | `src/agents/agent-types.ts` — `type` does not resolve to exactly one enabled agent, and no `agentConfig` was given |
| `No agent type given. Available: <list>.` | `src/agents/agent-types.ts` — `type` is empty and no `agentConfig` was given |
| `SpawnOptions.cwd must be an absolute path: "<value>"` | `src/manager/agent-manager-rules.ts:38` |
| `SpawnOptions.cwd does not exist: "<cwd>"` | `src/manager/agent-manager-rules.ts:44` |
| `SpawnOptions.cwd is not a directory: "<cwd>"` | `src/manager/agent-manager-rules.ts:47` |
| `Cannot run with isolation: "worktree" — not a git repo, no commits yet, or 'git worktree add' failed.` | `src/manager/agent-start.ts:178-181`, surfaced through `awaitStartup` |
| git plumbing failures | `src/platform/worktree.ts:76` |
| `Agent not found` | stop — `src/triggers/cross-extension-rpc.ts:201` |
| `Agent is owned by another agent` | stop — `:178` |
| `Agent is not running` | stop — `:182`. The record exists, so it has already settled |
| `Agent not found or still running` | consume — `:193` |

**The in-session `stop_subagent` tool diverges from this on the already-settled case.** Both resolve to the same `manager.abort()` call and the same `isTopLevelAgent` ownership check, but where the RPC channel throws `Agent is not running` for a record that has already settled, the tool reports its terminal status as a normal (non-error) result.

The model's intent — "that agent should not be running" — is already true, and an `isError: true` result is the wrong signal for "nothing to do". An extension, by contrast, can and should branch on an error envelope.

Don't mirror the tool's wording back into the RPC error string, or a caller that pattern-matches on `Agent is not running` silently stops seeing it.

Three things the table cannot show:

- **The failure that is not an error.** With `worktreeIsolation` off project-wide, the spawn funnel and `src/manager/agent-start.ts` drop `isolation: "worktree"`. They raise no error and leave no note on the record. The wire carries a success envelope. Your agent runs in the main tree. If you asked for isolation because two agents were going to write the same files, they now collide and nothing told you.
- **`data` is omitted** when a handler returns nothing, so a successful stop or consume reply is a bare `{ success: true }` and `reply.data.anything` throws.
- **`requestId` is not validated.** It is interpolated straight into the reply channel, so a caller that omits it gets its reply on the literal channel `subagents:rpc:spawn:reply:undefined` — where every other caller that omitted it is also listening. Send one, and send a unique one.

## Ownership

`isTopLevelAgent(record)` is `parentAgentId === undefined` (`src/manager/agent-manager-rules.ts:75`). `subagents:rpc:stop` enforces it (`src/triggers/cross-extension-rpc.ts`): a nested child is owned by something that is *waiting on it*, and aborting it out from under that owner turns another extension's stop into a failed step. It is defence in depth rather than a live hole — no RPC hands out agent ids, so a caller has no ordinary way to name one it does not own.

One asymmetry to know about, stated as it is:

- **Stop takes an id only** (`src/index.ts:806`). Consume takes an id *or* an `@handle`, through `resolveAgentRef` (`src/index.ts:816` → `:731-736`).

The same predicate silently scopes the events. **Every lifecycle event is top-level only** — `subagents:started`, `:completed`, `:failed` and `:compacted` all return early for nested agents (`src/index.ts`). A nested child is invisible on the bus: you will see its parent come and go without a single event for the child.

**Stop no longer just fires the abort signal and stops there.** `manager.abort(id)` — the same call this channel makes — used to release the run's concurrency slot, stop its nested children, and notify only once the run's own promise settled, which for an agent wedged inside a tool call that never returns might never happen.

A grace-period timer (5s) now forces that settle tail if the real one hasn't fired by then, so a `subagents:rpc:stop` call reliably frees its slot and fires `subagents:completed`/`:failed` within a few seconds even for a wedged agent, instead of leaking the slot and withholding the event forever.

The forced tail also copies the streamed response text into `record.result` when no result exists, so that event (and the notification) carries the partial output instead of an empty `result`. Nothing about the reply envelope changes — `stop` still replies before the settle tail runs, forced or otherwise.

## The notification race

When a background agent finishes, pi-subagents sends the user a completion notification. If you have already shown the model that result yourself, that notification arrives on top of an answer that was already given, and it costs the parent a turn to dismiss. `subagents:rpc:consume` is how you say you have handled it — the bus-side half of what `get_subagent_result` does when it returns a result.

**When you send it decides whether it works.** The timeline:

1. The agent settles and `subagents:completed` is emitted — `src/index.ts:581`.
2. Eleven lines later, at `src/index.ts:592`, the code checks `record.resultConsumed` and decides whether to notify at all.
3. `pi.events` dispatch is synchronous and in-process, so a handler that emits `subagents:rpc:consume` **without awaiting anything** has already set that flag before step 2 evaluates.

| When you consume | What happens |
| --- | --- |
| Synchronously, inside your `subagents:completed` handler | The notification is never scheduled. This is the clean path |
| After an `await`, within 200 ms | Still suppressed. The nudge is held for `NUDGE_HOLD_MS` (`src/index.ts:451`), `consume` cancels the pending timer (`:819`), and there is a re-check at send time (`:474`) |
| After 200 ms | Too late. The follow-up has fired with `triggerTurn: true` and cost the parent a turn |

Fire-and-forget is the intended use: the reply carries nothing to act on, and the channel sits outside the `subagents:rpc:ping` version handshake on purpose (`src/triggers/cross-extension-rpc.ts:220`), so you can send it unconditionally and an older pi-subagents with no handler simply keeps notifying.

Consumption is not terminal. An `@handle` steer un-consumes the record (`src/index.ts:920`) because the agent's reply to that message still needs relaying, and so does a background resume (`src/manager/agent-resume.ts:104`) because the record is starting a new run.

One related thing that lives nowhere else: on every top-level settle, pi-subagents writes a session entry — not an event — via `pi.appendEntry("subagents:record", …)` (`src/index.ts:585`), carrying `id`, `type`, `description`, `status`, `result`, `error`, `startedAt` and `completedAt`. It exists for cross-extension history reconstruction. It is append-only history, not something to react to.

## The manager registry

`globalThis[Symbol.for("pi-subagents:manager")]` (`src/index.ts:649-659`) is a second integration surface — the standard Node cross-package singleton pattern, no bus involved:

| Member | Signature | Notes |
| --- | --- | --- |
| `waitForAll()` | `() => Promise<void>` | Resolves when nothing is running. **All** agents, including ones you did not spawn — a shutdown barrier, not a join |
| `hasRunning()` | `() => boolean` | |
| `spawn(pi, ctx, type, prompt, options)` | `=> string` | **Is** `spawnTopLevel`, so the strip list above applies identically |
| `getRecord(id)` | `=> AgentRecord \| undefined` | Filtered through `isTopLevelAgent`, so someone else's child comes back `undefined` rather than leaking |

The slot is claimed by the first activation only; subagent sessions re-activate this extension in the same process, and unconditionally overwriting would point the registry at a short-lived child manager whose shutdown would then delete the root session's entry. Child activations leave it alone, and shutdown releases it only if this activation claimed it (`src/index.ts:747-750`, `:1105-1107`).

Prefer the bus. The registry has no reply envelope, no version, and no availability event — `globalThis[Symbol.for("pi-subagents:manager")] === undefined` is the only probe you get, and it is also `undefined` in a session that filtered pi-subagents out. Reach for it for the two things the bus has no verb for — *is anything still running*, and *give me a settled record back* — or for a headless host that wants to block on `waitForAll()` before exiting.

## Protocol versions

`subagents:rpc:ping` replies `{ version: PROTOCOL_VERSION, policy }`, currently `2` (`src/triggers/cross-extension-rpc.ts:33`). The constant was introduced already equal to `2` in 0.5.0; "v1" is a retroactive name for the pre-envelope contract, where spawn replied with a bare `{ id }` or `{ error }`, stop replied `{ success: boolean }` with no message, and each handler caught its own errors.

`policy` is `{ global, project, ephemeralNesting }`: each file's `allow` and `deny` lists for `tools`, `extensions`, and `skills`, and the merged `ephemeralNesting`. It is read from disk on every ping, so it is the only copy that is always current, and it carries a `malformed` list of problems when the policy is malformed and every spawn is denied. `subagents:settings_loaded` and `subagents:settings_changed` carry the same object under `policy`, but a hand edit of `subagents.json` fires neither.

## Settings events

`subagents:settings_loaded` fires once at init. Its payload is `{ settings, policy }`, where `settings` is the merged global and project file, with only the keys the files set.

`subagents:settings_changed` fires when the `/agents` menu changes or resets a setting, including `policy.ephemeralNesting`. Its payload is `{ settings, persisted, layer, policy }`:

| Field | Meaning |
| --- | --- |
| `settings` | The effective settings, recomputed from both files and the defaults. Every `SubagentsSettings` key is present. |
| `persisted` | `false` when the write failed, so the change holds for this session only. |
| `layer` | `"global"` or `"project"`, the layer the change wrote to. |
| `policy` | `{ global, project, ephemeralNesting }`, as in the ping reply. |

A global change that the project overrides still fires the event, with `layer: "global"` and an effective `settings` that did not change. `PROTOCOL_VERSION` stays `2`.

Everything added since shipped **without a bump**, because all of it is additive: stop's ownership refusal, string-`model` resolution, `scopeModels` enforcement, and the whole `consume` channel.

> A `ping` that answers `2` does not tell you whether `consume` exists, whether model scope is enforced, or whether stop checks ownership.

So: send `consume` unconditionally and ignore the outcome — an older build has no handler and simply keeps notifying, which is exactly why it was left outside the handshake. And treat every error envelope as authoritative rather than trying to predict which checks are in force.

## Availability

`subagents:ready` is the discovery signal, and both the RPC handlers and the event itself are wired on the first bound `session_start` (`src/index.ts:789`, `:799`, `:827`) — deliberately not at factory time. pi runs every extension factory *before* applying an agent's `extensions:` filter and only delivers lifecycle events to the survivors, so a factory-time broadcast made a filtered-out session advertise a spawn service it could never provide: `ping` succeeded and every `spawn` answered `No active session`.

The consequence is worth stating plainly: **a session that excludes pi-subagents is indistinguishable from pi-subagents not being installed.** It emits no `subagents:ready` and answers nothing. Give discovery a timeout and treat expiry as "not available here" rather than waiting indefinitely. The payload is `{}` — read nothing off it. Handlers are torn down and the flag reset on `session_shutdown` (`src/index.ts:1100-1103`), so a later `session_start` re-registers and re-emits.

One more trap on the way in: an RPC-spawned agent emits **no `subagents:created`**. The only two emit sites are the `agent` tool's background branch (`src/index.ts:2104`) and detached resume (`:1350`). Your first event for your own agent is `subagents:started` (`:625`), so key your bookkeeping off the id that `spawn` handed you, not off `subagents:created`.

## What the tests pin

This document has no test of its own, so it is worth knowing which claims are actually held in place:

| Test | Level | Pins |
| --- | --- | --- |
| `test/cross-extension-rpc.test.ts` | Mocked `SpawnCapable` | Envelope shape, per-channel error strings, model resolution and scope enforcement |
| `test/rpc-lifecycle-gating.test.ts` | Real extension factory | Nothing wired at factory time, everything once at `session_start`, and live widget activity for RPC spawns |
| `test/rpc-result-consumption.test.ts` | Real delivery path | The notification firing, and not firing, around `consume` |
| `test/rpc-inline-agent.test.ts` | Real extension factory | An inline `agentConfig` skips type resolution, reaches `runAgent`, and stays out of the registry |

Not pinned anywhere, so treat them as descriptions rather than contracts: the `SpawnOptions.cwd` error strings, `subagents:ready`'s `{}` payload, and consume's handle resolution.

## Reference implementation

[**`tintinweb/pi-tasks`**](https://github.com/tintinweb/pi-tasks) is the working integration and the one this surface was shaped by. Its `TaskExecute` drives `subagents:rpc:spawn` — including the serialized `"provider/modelId"` string form that the boundary now resolves — and its `TaskOutput` drives `subagents:rpc:consume`, which exists because pi-tasks joins an agent on `subagents:completed` and reports the result itself ([pi-tasks#62](https://github.com/tintinweb/pi-tasks/issues/62)).

Read it for the shape of the whole loop: waiting on `subagents:ready`, keeping an id-keyed map of outstanding spawns, resolving each from the `subagents:completed` / `subagents:failed` handler, and consuming the result in the same synchronous handler that reports it.
