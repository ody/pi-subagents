# 0046. The protocol version changes only on a breaking change, and errors carry codes

## Context

A caller must know whether it can talk to this extension. A version that changes only on a breaking change cannot tell it which additive features exist.

Callers branch on failures. An error message is prose and changes with wording edits.

pi-advisor (`codeberg.org/ody/pi-advisor`) is the consumer this project keeps working. The same owner maintains it and can update it with each break.

## Decision

Envelope:

- A request carries a non-empty string `requestId`. The handler ignores a request without one and sends no reply.
- Every reply goes to `<channel>:reply:<requestId>`. It is `{ success: true, data? }` or `{ success: false, code, error }`.
- `code` comes from the closed set in `docs/rpc.md`. Each code is lowercase snake_case and names one cause that a caller can act on, such as `not_found`, `not_running`, `policy_denied` or `model_out_of_scope`.
- `error` is text for people and is not part of the contract.

Version and features:

- `agent:rpc:ping` replies `{ version, features, policy }`. `version` is `PROTOCOL_VERSION` in `src/triggers/cross-extension-rpc.ts`, and `docs/rpc.md` states its value.
- A feature name is lowercase snake_case and unique. A name is never used twice, even after a reset.

A breaking change bumps `version` and resets `features` to `[]`. These changes are breaking:

- Removing or renaming a channel, event, field, option, code or feature.
- Changing a field's type or meaning, or changing a default.
- Refusing a request that the same version accepts, including with a new code.

An additive change keeps `version` and appends one name to `features`. These changes are additive:

- A new channel, event, optional option, or reply or payload field.
- A new code for a request that already fails, which replaces its earlier code.

Consumers:

- A breaking change ships with the matching pi-advisor change.
- The compatibility of any other consumer is no reason to keep or shape the contract.

Rejected:

- Additive changes without feature names: callers cannot detect them.
- A bump on every change: each caller that checks equality breaks on each release.
- Error text as the contract: every wording edit becomes a break.

Done check: `npx vitest run test/triggers/cross-extension-rpc.test.ts` passes. It asserts the ping reply shape and a `code` on each failure of each channel. It asserts no reply to a request without `requestId`, and that every code thrown appears in `docs/rpc.md`.

## Consequences

- Each additive change costs a feature name, a `docs/rpc.md` row, and a test.
- pi-advisor must check `version` and branch on `code`, not on `error`.
- Revisit if a consumer outside this owner's control appears. It would need a deprecation window, which this rule does not give.
