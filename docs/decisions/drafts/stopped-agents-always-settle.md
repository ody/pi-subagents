> DRAFT: not accepted, not current truth.

# NNNN. A stopped agent always settles, and the model can stop its own agents

## Context

An agent wedged inside a tool call never resolves its `runAgent` promise. `AgentManager.abort()` used to leave the rest to that promise: releasing the concurrency slot, stopping nested children, flushing the output file, and firing the completion notification. For a wedged agent none of that ran, so three such stops could hold the background pool and the orchestrator never heard back.

`steer_subagent` cannot reach a wedged agent either, since a steering message lands only after the current tool call. Before `stop_subagent`, stopping needed a person in `/agents` or another extension's `subagents:rpc:stop`.

## Decision

`abort()` on a running agent always leads to a settle within `FORCED_SETTLE_GRACE_MS` (5 s, `src/agent-manager.ts`).

- `abort()` fires the abort signal and arms an unref'd timer that calls `forceSettle`. `forceSettle` stops owned children, flushes the output file, and runs the shared `settleRun` tail.
- `settleRun` is guarded by `record.settled`. Whichever of the real settle and the forced one runs first wins; the other is a no-op, so nothing is released or notified twice.
- Every stop path goes through `abort()`: the `stop_subagent` tool, its nested mirror, `/agents`, FleetView, the conversation viewer, and `subagents:rpc:stop`.

The model-facing `stop_subagent` tool, and the nested copy in `src/nested-tools.ts`, follow these rules:

- It acts only on agents the caller owns: `isTopLevelAgent` records for the top-level tool, the caller's own children for the nested one. Anything else is reported as not found.
- Stopping an agent that already settled is a success that reports its terminal status, not an error.
- It never marks the result consumed or cancels the completion notification. The full result has not been written yet when the tool returns. The top-level tool also returns the partial streamed text.
- It sets `stoppedBy: "agent"` before calling `abort()`, so the forced settle reports who stopped it.

Done check: `npx vitest run test/abort-forced-settle.test.ts test/stop-subagent-wiring.test.ts` passes.

## Consequences

- Removing the forced settle brings back leaked pool slots and lost completion notifications for wedged agents.
- Marking the result consumed on stop would lose the full output for a model that does not call `get_subagent_result`.
- The grace period trades a 5 s delay against cutting off a responsive agent mid-flush or a slow `git worktree remove`. Revisit if worktree cleanup regularly takes longer.
