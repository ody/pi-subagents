> DRAFT: not accepted, not current truth.

# NNNN. Every agent run settles exactly once, through one tail

Replaces: 0008-stopped-agents-always-settle, last present in 3449c56

## Context

A record (`AgentRecord`) runs more than once: a spawn starts it, and each resume or `@handle` message starts it again. A run ends by finishing, failing, hitting the turn limit, failing to start, or a stop while queued, during worktree creation, or while running.

The concurrency pools, lifecycle events, the `subagents:record` entry, group joins, and completion notifications each need exactly one ending per run. A slot released twice admits too many agents, and a slot never released blocks the queue.

A run wedged inside a tool call never resolves its `runAgent` promise. A tool process of that run can still write into its worktree.

## Decision

Every run that leaves `queued` or `running` settles exactly once, through `settleRun` in `src/manager/agent-manager.ts`. No other function sets `settled` or calls the completion callback. `abortAll` at shutdown is the one exception: it stops runs and does not settle them.

- Every run, spawn or resume, sets `isBackground` and `blocking` from its own call. A resume is `blocking` exactly when it is foreground: the `agent` tool's `resume` and the nested resume. `poolFor` picks the run's pool, the run stores it, and a full pool queues the run.
- A run that resolves sets its terminal status and `completedAt`, never replacing `stopped`. It then saves and removes its worktree and appends the branch or failure note, even after a forced settle.
- A start that throws sets `error` and enters the tail. A direct start also rethrows to its caller, and the tail marks its result consumed.
- A stop while queued or during worktree creation enters the tail.
- `abort()` on a running run arms an unref'd `FORCED_SETTLE_GRACE_MS` (5 s) timer. When it fires on an unsettled run, `forceSettle` enters the tail. First it sets the result to the streamed text if none exists, and adds the worktree path if any.

The tail, in order:

1. Set `settled`. A second entry returns at once.
2. Detach the parent abort signal, then flush and close the output file.
3. Stop the run's owned children with `stopCause: "owner"` (ADR NNNN, stopping an agent).
4. Release the slot this run took. Mark a foreground run's result consumed.
5. Call the completion callback, then drain the queue.

Terminal statuses: `completed`, `steered` (wrapped up after the `maxTurns` steer), `aborted` (reached `maxTurns + graceTurns`), `stopped`, and `error`.

Rejected:

- A settle per start path: the copies drift and leak or double-release slots.
- A forced settle that saves the worktree: it commits under a live tool process and can run tens of seconds past the grace period.

Done check: `npx vitest run test/manager/agent-lifecycle.test.ts test/settle-tail.test.ts test/abort-forced-settle.test.ts` passes. The lifecycle test covers each ending, on a spawn and a resume, in each pool and with no pool. The settle-tail test fails when a `src/` file other than `agent-manager.ts` assigns `.settled` on a record, or references `onComplete` outside the `AgentManager` constructor.

## Consequences

- A second settle path leaks or double-releases pool slots and duplicates or drops completion events.
- `subagents:failed` fires for a stop while queued and for a failed start. Foreground resumes emit `subagents:completed` or `subagents:failed` and append `subagents:record`. RPC consumers see one event per run.
- With `maxConcurrentForeground` set, a foreground resume can queue.
- The grace period trades a 5 s delay against cutting off a responsive run mid-flush.
- A forced stop leaves the worktree on disk until the run resolves. Revisit if pi can kill a run's tool processes.
