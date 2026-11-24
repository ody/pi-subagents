# 0051. Provider-stage failures on `agent:failed`

## Context

pi-advisor falls back to another model when a run fails at the provider. It must not fall back when a run fails to start, fails on configuration, stops, or aborts. All of these can reach `agent:failed`, and `error` is display text.

pi marks a failed provider response with `stopReason: "error"` on the assistant message. pi exposes no structured cause, such as quota exhaustion or throttling, on that message.

## Decision

`agent:failed` carries `failure: { stage: "provider" }` exactly when the run's status is `error` and the last assistant message of that run has `stopReason: "error"`.

- Derive the stage only from `stopReason`. Never classify from `error`, `errorMessage`, or an HTTP status.
- A run's stage comes only from messages that run added. Every resume clears it, so no stage carries over from an earlier run.
- Omit `failure` for startup or configuration errors, a thrown run, a final `length` stop with no text, `stopped`, and `aborted`.
- `failure` has no `kind`. Never add one without structured provider evidence for it.
- Keep `failure` off `agent:completed`, `agent:record`, and RPC replies. Every other event field keeps its meaning.
- `docs/rpc.md` documents the field. `agent:rpc:ping` lists `agent_failed_provider_stage` in `features`, without a version bump, per [ADR 0046](0046-rpc-versioning-and-error-codes.md).

Rejected: matching rate-limit or quota text in `error`. Text can name a limit that did not end the run, and the wording changes between providers.

Done check: `npx vitest run test/e2e/subagent-error-status-e2e.test.ts test/triggers/cross-extension-rpc.test.ts test/manager/run-outcome.test.ts test/manager/agent-lifecycle.test.ts test/session/session-text.test.ts test/lifecycle-events.test.ts` passes. The tests pin these cases:

- The field on a provider error, with and without response text.
- Its omission for each excluded case.
- A resume that clears an earlier stage.
- The ping feature.

## Consequences

A caller learns that the provider ended the run, not why. pi-advisor owns fallback and retry policy, and it treats every provider-stage failure the same.

Revisit when pi exposes a structured provider cause on the assistant message. A `kind` is then an additive change with its own feature name.
