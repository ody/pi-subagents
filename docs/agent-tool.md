# The agent tools

The extension registers four model-facing tools: `agent`, `agent_get_result`, `agent_steer`, and `agent_stop`. A nested agent owns scoped copies of the same four, limited to its own children. Each tool section below names where the nested copy differs. See [Nested subagents](agents.md#nested-subagents).

## `agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary, shown in the UI |
| `name` | string | no | Memorable name for this agent (`auth-audit`), addressable as `@name` and accepted by `agent_steer`/`agent_get_result`/`agent_stop`. Additive: the type-derived handle is still assigned. Top-level only: the nested tool has no `name` |
| `subagent_type` | string | no | Agent type to run. Omit it to build a one-off [ephemeral agent](#ephemeral-agents) from the parameters below. Ignored with `resume` |
| `tools` | `string[]` | no | Ephemeral only. `*`, built-in names, `none`, and `ext:` selectors, as in the agent file `tools` field. Default: every built-in and every extension tool |
| `disallowed_tools` | `string[]` | no | Ephemeral only. Tools to remove, built-in or from an extension |
| `extensions` | `boolean` \| `string[]` | no | Ephemeral only. Default `true` |
| `exclude_extensions` | `string[]` | no | Ephemeral only. Extensions to leave out |
| `skills` | `boolean` \| `string[]` | no | Ephemeral only. Default `true` |
| `allowed_subagents` | `"all"` \| `string[]` | no | Ephemeral only. Default `[]`, which means no nesting. Refused when `policy.ephemeralNesting` is `false` |
| `prompt_mode` | `"append"` \| `"replace"` | no | Ephemeral only. Default `append` |
| `model` | string | no | Model as `provider/modelId` or a fuzzy name (`"haiku"`, `"sonnet"`). Resolved tolerantly, with provider fallback. See [Model resolution](agents.md#model-resolution) |
| `thinking` | string | no | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Availability depends on pi version and model |
| `max_turns` | number | no | Max agentic turns; `0` means no limit. Overrides the agent's frontmatter; omit to use it, then [`defaultMaxTurns`](settings.md#turn-limits) |
| `run_in_background` | boolean | no | Overrides the agent's frontmatter; otherwise follows [`backgroundByDefault`](settings.md#background-by-default). `false` blocks and returns the result inline. The parameter description states the current default and is re-registered when the setting changes |
| `resume` | string | no | Agent ID to resume a previous session. See [Resume](#resume). The nested tool takes only the ID of a child the caller owns |
| `isolated` | boolean | no | No extension or MCP tools |
| `isolation` | `"off"` \| `"worktree"` | no | `worktree` runs in an isolated git worktree; `off` (the default) does not. Absent from the schema entirely when [`worktreeIsolation`](settings.md#worktree-isolation) is `false` |
| `inherit_context` | boolean | no | Fork the parent conversation into the agent |

## Ephemeral agents

A call with no `subagent_type` runs an agent built from its parameters, and the agent never enters the registry.

- Passing `tools`, `disallowed_tools`, `extensions`, `exclude_extensions`, `skills`, `allowed_subagents`, or `prompt_mode` together with a `subagent_type` is an error that names the parameter.
- The extension refuses `isolated: true` together with `extensions`, `skills`, or an `ext:` entry in `tools`.
- There is no system prompt parameter. `prompt` is the task. `append` reuses the session's system prompt, and `replace` gives the sub-agent preamble and an environment block.
- The defaults are every built-in tool, `extensions: true`, `skills: true`, `allowed_subagents: []`, the session's model, `inherit_context: false`, `isolated: false`, and no worktree. `max_turns` follows [`defaultMaxTurns`](settings.md#turn-limits), and `run_in_background` follows [`backgroundByDefault`](settings.md#background-by-default).
- The extension mints the type as `ephemeral-<8 hex>`, and skips an agent file whose name starts with `ephemeral-` with a warning. Lifecycle events carry the minted type.
- The handle is `name`, else a slug of `description`, else `agent`, with no alias. The name badge is `name`, else the first three words of `description` title-cased, else `Agent`.
- A top-level ephemeral agent persists its session as [`rememberAgents`](settings.md#remember-agents) says, and no parameter overrides that. A nested ephemeral agent never persists. The agent is steerable and resumable while its record is in memory. Once the extension evicts the record, `@handle` reopens the agent from the config its tombstone stores.
- The extension checks every value against the [capability policy](settings.md#capability-policy).
- The nested `agent` tool takes the same optional type and the same ephemeral parameters, and runs the child in the foreground by default. The extension allows a nested ephemeral child only when the parent's `allowed_subagents` is `all`. A caller-supplied value outside the parent's set refuses the spawn. The extension narrows ephemeral defaults.
- In `agentMentions: "model"` mode, the extension refuses the conversation clone's `agent` call when it omits `subagent_type` or names a different type than the mention.

## Background and foreground

`run_in_background: true` detaches the agent. The call returns its ID immediately, and a completion notification carries a preview of the result. Use `agent_get_result` for the full text.

`run_in_background: false` blocks the turn and returns the agent's full output inline. pi can press `Esc` to cancel a foreground call, which stops the agent.

The pool limits are in [Concurrency](settings.md#concurrency). They bound how many agents run at once, separately for background and foreground.

## Join strategies

When background agents complete, they notify the main agent. The **join mode** controls how the extension delivers these notifications. It applies only to background agents.

| Mode | Behaviour |
| --- | --- |
| `smart` | Two or more background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually |
| `async` | Each agent sends its own notification on completion. Best when results need incremental processing |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow |

When the extension groups agents, a 30-second timeout starts after the first agent completes. If not all agents finish in time, the extension sends a partial notification with completed results. Remaining agents continue with a shorter 15-second re-batch window for stragglers.

Set the mode with [`defaultJoinMode`](settings.md#join-mode), or with `/agents` → Settings → Join mode.

## Resume

`agent({ resume: "<id>" })` continues a previous session, preserving full conversation context. `agent_get_result` accepts an ID too, and `agent_steer` reaches a live agent.

The resumed session keeps its model and thinking level. For a top-level resume, `run_in_background` and `max_turns` come from the resuming call, else from the run's original values. Pass `run_in_background: false` to block and get the result inline.

A nested resume always blocks until the run ends. It ignores `run_in_background` and `max_turns`, and keeps the run's original turn limit.

A resume uses the pool of its own call, not the pool of the agent's earlier runs. The manager refuses a resume in three cases:

- The record's earlier run has not settled.
- The worktree save is still running.
- The isolated worktree path is gone.

Stopping a resume from `/agents` or the conversation viewer stops that resume. A foreground resume emits `agent:started`, then `agent:completed` or `agent:failed`, and appends an `agent:record` entry.

## Graceful max turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns`, the extension sends the steering message *"Wrap up immediately — provide your final answer now."*
2. The agent gets up to [`graceTurns`](settings.md#turn-limits) grace turns to finish cleanly.
3. The extension hard-aborts only after the grace period.

## Run statuses

| Status | Class | Meaning | Icon |
| --- | --- | --- | --- |
| `running` | active | Executing | spinner frame, or `●` where a surface does not animate, accent |
| `queued` | active | Waiting for a concurrency slot | `◦` muted |
| `completed` | success | Finished naturally | `✓` green |
| `steered` | success | Hit the limit and wrapped up in time. Shown with the note `turn limit` | `✓` yellow |
| `aborted` | failure | Grace period exceeded | `✗` red |
| `error` | failure | Failed with an error | `✗` red |
| `stopped` | neutral | Stopped on request. `stopCause` says by whom | `■` dim |

The widget, the conversation viewer, and completion notifications all take icon and color from this one mapping. The widget keeps a finished row for two turn starts for the failure class, and for one turn start otherwise.

Every `stopped` run has a `stopCause`. The status text the model reads names it. A run the user stopped is not restarted unless the user asks. A resume clears `stopCause`.

| `stopCause` | Set by |
| --- | --- |
| `user` | `/agents`, the conversation viewer, or the session's interrupted tool call |
| `agent` | `agent_stop` or its nested mirror |
| `extension` | `agent:rpc:stop`, or an aborted spawn `signal` from `agent:rpc:spawn` |
| `owner` | The owner's settle, or the owning agent's interrupted tool call |
| `shutdown` | Session shutdown |

## `agent_get_result`

Check status and retrieve a background agent's result. Its completion notification carries only a preview.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID to check. The agent's handle also works: its `name` if you gave it one, otherwise its type (`explore`, `explore-2`). The nested tool takes only the ID of a child the caller owns |
| `wait` | boolean | no | Wait for completion. Default `false` |
| `verbose` | boolean | no | Include the agent's full conversation: messages and tool calls. Default `false`. Top-level only |

Cancelling a `wait: true` call, for example with `Esc`, stops only the wait. The background agent keeps running, and its completion notification still arrives normally.

The extension rebuilds tombstones from the active session branch on startup and tree navigation. Tree navigation removes settled top-level records absent from the active branch; running and queued agents remain. It retains up to 100 of the newest tombstones. A live record takes precedence over a tombstone, and for equal completion times the later branch entry wins.

After the extension evicts a top-level agent's record, `agent_get_result` can find its tombstone by ID, handle, or alias. It reports the stored status, result, error, and stop cause without tool-use, token, or duration stats. The tombstone answer consumes nothing. The nested tool does not check tombstones, and `agent_steer` and `agent_stop` reply "not found" for a tombstone.

## `agent_steer`

Send a steering message to a running agent. The message interrupts after the current tool execution.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID or handle of a running agent. The nested tool takes only the ID of a running child the caller owns |
| `message` | string | yes | Message to inject into the agent's conversation |

## `agent_stop`

Stop a running or queued background agent. The run records `stopCause` `agent`. This is the model's own lever to end a run. A human takes the same action with `x` in the conversation viewer or `/agents`, and `agent:rpc:stop` gives it to another extension.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent ID to stop. A handle or alias works too. The nested tool takes only the ID of a child the caller owns |

An already-completed, errored, or otherwise terminal agent reports its status and that the result is still available. This is success, not an error, since the model's intent ("that agent should not be running") is already true.

The top-level reply shows up to 500 characters of assistant text from before the stop. If there is no text, the reply says so. The nested reply carries no partial output.

The result arrives later through the ordinary completion notification, but only if the agent finishes. A stopped agent's notification carries whatever partial output it had streamed, which is also what `agent_get_result` returns afterwards. Stopping does **not** mark the result consumed, because at stop time `agent_get_result`'s data (`record.result`) does not exist yet.

## Tool results and transcripts

Individual agent results render in the conversation as follows:

| State | Example |
| --- | --- |
| **Running** | `⠹ ↻3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…` |
| **Completed** | `✓ ↻8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done` |
| **Wrapped up** | `✓ ↻50≤50 · 50 tool uses · 89.1k token (84% · ⇊2) · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped** | `■ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped` |
| **Error** | `✗ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout` |
| **Aborted** | `✗ ↻55≤50 · 55 tool uses · 102.3k token (95% · ⇊3)` / `⎿ Aborted (max turns exceeded)` |

Press `Ctrl+O` in pi to expand a completed result and show the full agent output inline.

By default, foreground and background agents each stream their full conversation to a per-subagent transcript. The transcript is a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output`, owner-only `0700`. The OS clears it on reboot.

Set [`outputTranscript`](settings.md#output-transcript) to make transcripts opt-in for the whole project, or `output_transcript: false` on one agent. That governs only the transcript. It is independent of `persist_session` (the pi session on disk) and of `isolation: worktree` (which commits the agent's work to a git branch). Set all three accordingly if the goal is to keep a run off disk entirely.

An agent's ID is a uuidv7 string. It is also the ID of the agent's pi session. The `.output` file name, the `agentId` field inside it, and the session file header all hold the same value. The session name takes the last 8 characters of the ID (`general-purpose#1a2b3c4d`). The worktree branch and path use the full ID.
