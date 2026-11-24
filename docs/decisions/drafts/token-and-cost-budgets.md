> DRAFT: not accepted, not current truth.

# NNNN. A token or cost budget caps an agent tree and the fleet

## Context

`maxTurns` counts turns, and one turn on a long cached context can cost dollars. A run has no spend brake.

Usage accrues per assistant message in `src/usage.ts`, and `addUsageToAncestors` adds a nested agent's usage to every ancestor. A top-level record's `lifetimeUsage` thus holds its whole tree's spend.

Cost is pi's per-message figure, and an unlisted rate contributes zero (ADR 0028). A cost ceiling alone never trips on such a model.

Five accepted ADRs constrain it:

- ADR 0013 bounds a nested spawn by its parent.
- ADR 0033 settles every run once.
- ADR 0034 routes every stop through `abort()` with a `stopCause`.
- ADR 0045 keeps the spawn option surface closed.
- ADR 0046 sets when the protocol version changes.

This decision amends ADR 0034, which gains the `budget` cause, and ADR 0046's code set, which gains `budget_exhausted`.

## Decision

A budget is a token ceiling, a cost ceiling, or both. Crossing either one stops the run.

**Unit.**

- The token ceiling counts `input`, `output`, `cacheWrite` and `cacheRead`: the components ADR 0028 reports. The widget's token display keeps its own narrower count.
- The cost ceiling counts pi's per-message cost as ADR 0028 sums it. A run whose assistant messages carry no cost spends nothing against a cost ceiling.

**Scope.**

- An agent budget covers one top-level agent and every descendant: the tree's `lifetimeUsage`. It covers the record's whole life, so a resume starts at the spend the record already made.
- The fleet budget covers every top-level tree of the session. `AgentManager` accumulates it once per assistant usage event, at the top-level tree, and not from the live record set, so a removed record still counts.

**Where the limit lives.**

- Settings `maxTokens`, `maxCost`, `fleetMaxTokens` and `fleetMaxCost` are the fallbacks, and `0` means no cap. `SETTING_SPECS` carries a `number` kind for the cost keys, with their bounds in the same table.
- Frontmatter keys `max_tokens` and `max_cost`, and `agent` tool parameters of the same names, set one run.
- `agent:rpc:spawn` accepts `maxTokens` and `maxCost`, listed in `RPC_SPAWN_OPTIONS`.
- The fleet keys are settings only: a fleet is a property of the session, not of a spawn.
- Precedence is the caller, then the file, then the setting (ADR 0014), with the same override disclosure as `max_turns`.
- A nested spawn's `max_tokens` and `max_cost` cap that agent's own subtree, counted from its own `lifetimeUsage`. The effective cap is the smaller of its own value and the parent's remaining budget at spawn time. A caller value above that narrows, and never refuses the spawn.
- A nested agent's spend also counts against every ancestor's cap, so a parent's cap still bounds all its children (ADR 0013).
- A mention clone refuses `max_tokens` and `max_cost`, as it refuses `max_turns`.
- An ephemeral agent takes its budget from the caller and the setting alone.

**The stop.** A cap has no grace turn.

- The check runs on every assistant usage event, and at admission for a spawn and a resume.
- A crossed cap stops the run through `abort()` with the `stopCause` `budget`, which settles once (ADR 0033). The settle saves and removes the worktree as for any stop.
- The `stopCause` set of ADR 0034 includes `budget`, both outcome tables in `src/tool/status-note.ts` carry its text, and `docs/rpc.md` lists it.
- A crossed fleet cap stops every running and queued top-level tree. Their children stop through their owner (ADR 0033).
- Admission while over a cap refuses the spawn or the resume. `agent:rpc:spawn` fails with the code `budget_exhausted`.
- A refusal of a request that the same version accepted is a breaking change (ADR 0046). `PROTOCOL_VERSION` rises by one, `features` resets, and `features` then gains `budgets` for the new options. The matching pi-advisor change ships with it.

Rejected, one line each:

- Cost as the only unit: an unpriced model spends zero, so a cost ceiling alone never trips. The token ceiling covers that case.
- A token count without `cacheRead`: a loop that re-reads one large context grows only there.
- One fleet ceiling and no per-tree ceiling: one expensive tree stays invisible.
- A ceiling per nested agent without its subtree: a parent could not bound its children (ADR 0013).
- Grace turns as `maxTurns` has them: a spend ceiling that spends past itself.

Done check: `npx vitest run test/manager/budget.test.ts test/manager/stop-cause.test.ts test/tool/nested-tools.test.ts test/triggers/cross-extension-rpc.test.ts test/config/settings.test.ts` passes. It covers both units, both scopes, the settings and frontmatter keys, and precedence and disclosure. It also covers nested narrowing, the ephemeral path, the refusal at admission, and the `budget_exhausted` and `budget` text.

## Consequences

- A fleet cap stops work the user wanted. Raising the cap is the repair, and the stop text names the cap it reached.
- A provider that reports no usage gives no brake: that run spends nothing against a ceiling.
- The fleet accumulator outlives removed records, so the session never forgets spend it already made.
- Revisit if pi exposes a session-wide spend meter. It would replace the manager's accumulator.
