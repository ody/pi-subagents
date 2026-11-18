# 0035. Reading a result consumes it, and the sweep removes settled records after 10 minutes

## Context

A foreground caller gets a run's full result inline. A background caller's completion notification carries only a preview, and the model reads the full result with `agent_get_result`. Most background results are never read in full.

A record holds a live `AgentSession`, so every record kept costs memory. The notifier holds a notification briefly before it sends it. A held nudge still sends for a removed record whose result nothing consumed. A batch that looks records up by id drops removed ones.

## Decision

A caller that reads a result in full consumes it, and the sweep bounds how long a settled record stays.

Consumption:

- Consumption applies to a settled run. A new run on the record clears it, and nothing else does.
- Four things consume a result: a foreground settle (ADR 0033), `agent_get_result` on a settled run, `agent:rpc:consume`, and the sweep.
- A completion notification never consumes a result.
- The notifier never sends a notification for a consumed result.

Retention:

- Every 60 s the sweep in `src/manager/agent-retention.ts` removes records that settled more than 10 minutes ago, consumed or not.
- The sweep skips a record while `isNotificationPending(id)` is true. The notifier answers it from its own state: the batch window, an open group join, or a scheduled nudge.
- Before it removes a record, the sweep marks it consumed. It makes a tombstone when the record has a handle and a session file.
- A session start or switch removes every consumed settled record at once. A consumed record has nothing left to deliver.

Rejected:

- Keeping unconsumed records until the model reads them: most never are, so memory has no limit.
- Counting the notification as consumption: it carries only a preview.
- A pending flag on the record: it copies the notifier's state, and a missed clear keeps the record for ever.
- A timing rule alone (cutoff longer than the longest hold): a later timeout change breaks it unseen.

Done check: `npx vitest run test/manager/agent-retention.test.ts test/manager/completion-notifier.test.ts` passes. The tests cover:

- each consumer, and the clear on a new run;
- a notification that leaves the result unconsumed;
- the sweep skipping a pending record, and removing an unconsumed one.

## Consequences

- An `@handle` steer into a running run does not clear consumption, so the "Consumption is not terminal" paragraph in `docs/rpc.md` names only a new run.
- After the sweep, `agent_get_result` cannot read the full result. Revisit when tombstones become durable, since the `agent:record` entry holds it.
- A record whose notification never leaves the pending state stays in memory. The notifier's own timeouts bound that.
- Revisit the 10 minute cutoff if the model often reads results later than that.
