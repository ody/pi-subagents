# 0053. Model resolution with exact version and snapshot constraints

## Context

Users write model strings as registry IDs or shorthand. Separators can vary without changing the model. Versions and snapshot dates identify different releases, even when the rest of the name matches.

Pi's registry determines which models are available. A provider can be a gateway rather than the model's owner.

## Decision

One resolver handles every model string that starts a run:

- an agent file's `model`
- a caller `model` on the `agent` tool and the nested `agent` tool
- a `model` string on `agent:rpc:spawn`, and the mention clone's `model`
- the pin a tombstone reopen re-resolves

A concrete `Model` object, a live resume, and an `enabledModels` entry never enter the resolver.

The pool is pi's available models. An empty pool resolves nothing; the full catalog is not a substitute.

An empty, whitespace-only, or date-only model part never matches. A blank caller `model` counts as absent.

1. A literal `provider/id` present in the pool wins.
2. For a qualified input, scan the named provider. Only if it has no eligible candidates, scan the full pool with the text after the first `/`.
3. For an unqualified input, scan the full pool.

In each scan, use the first rank that has eligible candidates:

1. Normalized equality of the complete ID.
2. Normalized equality of the base ID when the input omits the snapshot date.
3. Whole-token shorthand against the ID or display name, such as `sonnet 4.5`. Do not combine tokens from different fields.

Normalize case and treat `.` and `-` as equivalent. An explicit version must match the ID's complete ordered version. An explicit trailing `-YYYYMMDD` date must match the ID's snapshot date.

Candidates at the winning rank are equivalent only if their normalized IDs match after removing a trailing snapshot date. Distinct base IDs are ambiguous.

With `scopeModels` on, use `enabledModels` only to disambiguate the shorthand rank. Resolve among in-scope candidates only if they contain exactly one distinct base ID. An unresolved ambiguity never triggers cross-provider fallback.

For equivalent candidates and an undated input, prefer an undated ID, then the newest snapshot. Resolve remaining ties by the lexically smallest `provider/id`, never by pool order.

An unmatched caller `model` refuses the spawn. An unmatched frontmatter `model` leaves the pin unset, and the run takes the session model (ADR 0014).

Do not filter the initial pool by `enabledModels`. Apply ADR 0024 after resolution. Never retry another candidate if the scope check rejects the result.

On `agent:rpc:spawn`, an unmatched or ambiguous caller `model` fails with `model_not_found`. These semantics start at protocol version 5 with `features: []`. Ship the matching pi-advisor change under ADR 0046.

`/agents → Agent types` uses the same resolver and shows the resolved target when it differs from the configured pin.

Matching adds no model-facing text: the `model` parameter keeps its ADR 0031 wording, and no description or result states these rules.

Rejected: vector similarity for selection. Shared tokens cannot establish version identity. Similarity may rank user-facing suggestions after a miss, but never selects a model.

Rejected: pi's CLI matcher. Its `:thinking` suffix, authentication, and unknown-ID rules change what a pin means.

Done check: `npx vitest run test/config/model-resolver.test.ts test/config/model-scope.test.ts test/triggers/cross-extension-rpc.test.ts` passes, with fixtures for:

- Normalized ID equality ahead of shorthand, and whole-token shorthand without substring matches.
- Version mismatches, reordered version components, and missing explicit snapshots.
- A named-provider match, fallback on no eligible candidates, and no fallback on ambiguity.
- Ambiguous versions, duplicate IDs across providers, and the newest snapshot for an undated input, independent of pool order.
- Blank, whitespace-only, and date-only inputs.
- Shorthand unique in the pool or unique in scope, and ambiguity when scope is off.
- Scope refusal for an exact caller model and session-model fallback for a pin, without retrying another candidate.
- RPC protocol version and feature reset, blank caller input, and `model_not_found` on a miss or ambiguity.

## Consequences

`sonnet` selects `claude-sonnet-5-5` if it is the only match in the pool. With scope on, it also selects that model if other Sonnet versions match but only `claude-sonnet-5-5` is in scope. A user can give the version or full key if the shorthand remains ambiguous.

Revisit if pi exposes a registry matcher that enforces the same version, snapshot, and provider constraints.
