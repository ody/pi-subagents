> DRAFT: not accepted, not current truth.

# NNNN. A model string resolves under its named provider, then by rank

## Context

Hand-written model strings rarely match pi's registry id:

- a version separates its parts with `.` or `-`
- a release id carries a trailing `-YYYYMMDD` stamp
- a provider prefix names a gateway, not the model's owner

Pi's registry is the only authority on which ids exist, and credentials and settings decide its contents and its order.

A caller `model` is a user's own words (ADR 0031), and a frontmatter `model` is the user's choice (ADR 0014). A pin that fails to resolve drops the run onto the session model, so a cosmetic difference costs the user the model they named.

`enabledModels` is an exact allowlist (ADR 0024). Tolerating spelling and enforcing an allowlist are different jobs.

## Decision

One resolver handles every model string that starts a run:

- an agent file's `model`
- a caller `model` on the `agent` tool and the nested `agent` tool
- a `model` string on `agent:rpc:spawn`, and the mention clone's `model`
- the pin a tombstone reopen re-resolves

A concrete `Model` object, a live resume, and an `enabledModels` entry never enter it. No other path resolves a model string.

The pool is pi's available models. An empty pool resolves nothing; the full catalog is not a substitute.

Resolution, in order:

1. A literal `provider/id` present in the pool wins.
2. A qualified input, one containing `/`, matches only against the named provider.
3. When that provider yields nothing, the text after the first `/` matches against the whole pool.
4. A bare input matches against the whole pool.

Ranking inside a scan, highest first:

1. Normalized equality of the full key or of the id.
2. An id-substring or full-key-substring match.
3. A display-name substring match.
4. A match on every token across id, name, and provider.

A higher rank wins whatever the scores. Inside a rank, the shortest matching id or name wins. A qualified input never crosses providers while its named provider has any match.

Normalization lowercases text, treats `.` and `-` as equal, and ignores one trailing `-YYYYMMDD` stamp on either side. An undated query over dated snapshots selects the newest stamp; any other tie resolves by the smallest `provider/id`, never by pool order.

Blank, whitespace-only, and date-only input never match, and a blank caller `model` counts as absent. No match means no model.

An unmatched caller `model` refuses the spawn. An unmatched frontmatter `model` leaves the pin unset, and the run takes the session model (ADR 0014).

Matching is scope-blind: it selects from the whole pool, then ADR 0024 checks the result against `enabledModels`. The check never retries a runner-up, and the allowlist never narrows the pool.

`/agents → Agent types` shows the resolved target when it differs from the configured pin.

Matching adds no model-facing text: the `model` parameter keeps its ADR 0031 wording, and no description or result states these rules.

Rejected: pi's CLI matcher, because its `:thinking` suffix, auth, and unknown-id rules change what a pin means. Rejected: refusing every tie, because a pin must resolve without a prompt.

Done check: `npx vitest run test/config/model-resolver.test.ts test/config/model-scope.test.ts` passes, with fixtures for:

- a normalized-equal id that outranks a full-key substring match
- a named-provider fuzzy match that beats a gateway entry whose id equals the whole input
- a named provider that lacks the model, falling back to a provider that has it
- duplicate ids under two providers, returning one model with the pool in either order
- blank, whitespace-only, and date-only input, returning no match
- an undated query over two dated snapshots, returning the newest in either pool order
- an out-of-scope caller model, refused, and an out-of-scope pin, replaced by the session model

## Consequences

A qualified pin stays on its named provider, so a gateway entry cannot capture it. A provider that lacks the model gives the nearest match there or none.

Ranking above scores keeps an identical id ahead of every partial match.

A tie resolves by provider name, so two providers holding the same id give one fixed answer until the user qualifies the string.

An exact post-check keeps scope separate, so an in-scope candidate the user did not name stays unused.

Revisit if pi exports `resolveModelReference` from its package root and thinking suffixes become desirable.
