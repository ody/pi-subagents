# 0034. Every stop goes through `abort()` and records its cause

Replaces: 0008-stopped-agents-always-settle, last present in f56bafc

## Context

The user, the model, another extension, an owner's settle, and shutdown can each stop a run. The model reads why a run stopped from its status text, and acts on it. A stop by the user is not a failure to retry.

The model needs a way to stop its own agents. `steer_subagent` cannot reach a wedged agent, because a steering message lands only after the current tool call.

## Decision

Every stop goes through `AgentManager.abort()`, which takes the stop cause. `abortAll` at shutdown is the one exception. The settle that follows a stop is ADR 0033.

`AgentRecord.stopCause` replaces `stoppedBy`. The manager registry's `getRecord` returns it, and `docs/rpc.md` documents it. Every `stopped` run has a `stopCause`, and model-facing status text names it:

| `stopCause` | Set by |
| --- | --- |
| `user` | `/agents`, FleetView, the viewer, or the session's interrupted tool call |
| `agent` | `stop_subagent` or its nested mirror |
| `extension` | `subagents:rpc:stop`, or an aborted spawn `signal` from `subagents:rpc:spawn` or the manager registry |
| `owner` | The owner's settle, or the owning agent's interrupted tool call |
| `shutdown` | `abortAll` |

A signal that is already aborted at spawn gives the cause of that signal's owner.

The `stop_subagent` tool in `src/tool/agent-control-tools.ts`, and its nested mirror in `src/tool/nested-tools.ts`:

- The top-level `agent_id` accepts an agent id, handle, or alias. The nested tool accepts only the id of a direct child of the caller.
- It acts only on agents the caller owns (ADR 0007). An unknown or unowned agent reports not found.
- Stopping an agent that already settled is a success that reports its terminal status.
- It never marks the result consumed or cancels the completion notification. The settle sets the result after the tool returns, so the notification carries it.
- The top-level tool returns the partial streamed text. Its reply says the full result arrives only if the agent finishes.

Rejected: only `user` and `agent` causes. A stop by another extension then reads as the user's.

Done check: `npx vitest run test/manager/stop-cause.test.ts test/stop-subagent-wiring.test.ts test/tool/nested-tools.test.ts` passes. The stop-cause test covers each row of the table and the already-aborted signal.

## Consequences

- A stop path that skips `abort()` loses the forced settle and the cause.
- A new stop source needs a cause value and its status text.
- Marking the result consumed on stop would suppress the stopped-status signal and the result preview. `get_subagent_result` stays the way to read the full output.
