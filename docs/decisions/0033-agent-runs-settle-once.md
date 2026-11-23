# 0033. Every agent run settles exactly once, through one tail

Replaces: 0008-stopped-agents-always-settle, last present in f56bafc

## Context

A record (`AgentRecord`) runs more than once: a spawn starts it, and each resume or `@handle` message starts it again. A run ends by finishing, failing, hitting the turn limit, failing to start, or a stop while queued, during worktree creation, or while running.

The concurrency pools, lifecycle events, the `agent:record` entry, group joins, and completion notifications each need exactly one ending per run. A slot released twice admits too many agents, and a slot never released blocks the queue.

A run wedged inside a tool call never resolves its `runAgent` promise. A tool process of that run can still write into its worktree.

## Decision

Every run that leaves `queued` or `running` settles exactly once, through `settleRun` in `src/manager/agent-manager.ts`. Only `settleRun` sets `settled` or calls the completion callback. `AgentManager.reopenRun` is the one other writer: it clears `settled` when a resume starts a new run. `abortAll` at shutdown is the one exception to settling: it stops runs and does not settle them. The shutdown entry of ADR 0050 is the one `agent:record` entry written outside `settleRun`.

- Every run, spawn or resume, sets `isBackground` and `blocking` from its own call. A resume is `blocking` exactly when it is foreground: the `agent` tool's `resume` and the nested resume. `poolFor` picks the run's pool, the run stores it, and a full pool queues the run.
- A run that resolves sets its terminal status and `completedAt`, never replacing `stopped`. It then saves and removes its worktree and appends the branch or failure note, even after a forced settle.
- Late cleanup after a forced settle updates `record.result` and `worktreeResult`. It does not settle again, emit another lifecycle event, append another `agent:record` entry, or send another completion notification.
- A start that throws sets `error` and enters the tail. A direct start also rethrows to its caller, marks its result consumed, and removes its record once the tail has run.
- A new run on a record supersedes its earlier run. The earlier run's late ending, and a forced-settle timer armed for it, change nothing on the record.
- The manager refuses a resume while the earlier run has not settled or is still saving its worktree. A failed save counts as done. A resume then never shares a slot or a worktree with a run that is still ending.
- A stop while queued or during worktree creation enters the tail.
- `abort()` on a running run arms an unref'd `FORCED_SETTLE_GRACE_MS` (5 s) timer. When it fires on an unsettled run, `forceSettle` enters the tail. First it sets the result to the streamed text if none exists, and adds the worktree path if any. That note describes the state at stop time.

The tail, in order:

1. Set `settled`. A second entry returns at once.
2. Detach the parent abort signal, then flush and close the output file.
3. Stop the run's owned children with `stopCause: "owner"` (ADR 0034).
4. Release the slot this run took. Mark a foreground run's result consumed.
5. Call the completion callback, then drain the queue.

Terminal statuses: `completed`, `steered` (wrapped up after the `maxTurns` steer), `aborted` (reached `maxTurns + graceTurns`), `stopped`, and `error`.

Rejected:

- A settle per start path: the copies drift and leak or double-release slots.
- A forced settle that saves the worktree: it commits under a live tool process and can run tens of seconds past the grace period.

Done check: `npx vitest run test/manager/agent-lifecycle.test.ts test/settle-tail.test.ts test/abort-forced-settle.test.ts` passes. The lifecycle test covers each ending, on a spawn and a resume, in each pool and with no pool. It also covers late worktree result updates without a second completion. The settle-tail test fails when a `src/` file other than `agent-manager.ts` assigns `.settled` on a record, or references `onComplete` outside the `AgentManager` constructor.

## Consequences

- A second settle path leaks or double-releases pool slots and duplicates or drops completion events.
- `agent:failed` fires for a stop while queued and for a failed start. Foreground resumes emit `agent:completed` or `agent:failed` and append `agent:record`. RPC consumers see one event per run.
- With `maxConcurrentForeground` set, a foreground resume can queue.
- A foreground resume emits `agent:started` before its `agent:completed` or `agent:failed`, as a background resume does.
- The grace period trades a 5 s delay against cutting off a responsive run mid-flush.
- A forced stop leaves the worktree on disk until the run resolves. Revisit if pi can kill a run's tool processes.
