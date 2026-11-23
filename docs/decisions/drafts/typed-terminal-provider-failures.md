> DRAFT: not accepted, not current truth.

# NNNN. Typed terminal provider failures on `agent:failed`

## Context

pi-advisor needs a machine-readable cause to decide whether to retry with a fallback model. A provider quota failure and a startup failure can both settle with `status: "error"`. The `error` field is display text. RPC error codes describe request failures, not run outcomes.

## Decision

`agent:failed` may carry `failure: { stage: "provider", kind: "quota_exhausted" | "rate_limited" }`. Set `kind` only when structured provider evidence distinguishes exhausted quota from request throttling. Never classify by display text or an ambiguous HTTP status.

- Read the structured cause from the pi session's terminal assistant result for this run. Preserve it through spawn and resume to the single settle path in [ADR 0033](../0033-agent-runs-settle-once.md). Never reuse a cause from an earlier turn, retry attempt, or run.
- Emit `failure` when a verified quota exhaustion or rate limit determines the top-level run's `error` status. Omit it for startup or configuration errors, stops, aborts, empty output alone, and unknown failures. A verified provider failure can have no response text.
- Keep all other event fields and meanings. Keep `failure` off RPC replies, `agent:completed`, and `agent:record`. Document the field in `docs/rpc.md`. Append `agent_failed_provider_cause` to `agent:rpc:ping` features without a version bump, per [ADR 0046](../0046-rpc-versioning-and-error-codes.md).

Rejected: match strings in `error`. Text can mention rate limits without proving that one ended the run.

Done check: `npx vitest run test/e2e/subagent-error-status-e2e.test.ts test/triggers/cross-extension-rpc.test.ts` passes. Tests pin both kinds on the bus, the omission cases, and the ping feature. Include an untyped error that mentions a rate limit and a resume that must not reuse a prior cause.

## Consequences

Providers that do not expose enough structured evidence produce no typed cause. The ping feature announces the field, not coverage for every provider.

pi-subagents reports the failure. pi-advisor owns fallback model selection and retries. Revisit the set of causes when a caller needs to act on another verified provider failure.
