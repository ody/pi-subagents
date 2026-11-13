# 0028. Subagent spend counts toward the session's totals only on request

## Context

A subagent runs in its own pi session. pi's footer, statusline, and `/cost` count only the main session's messages, so a session that delegated most of its work reads as nearly free.

`reportUsage` (default `false`) adds subagent usage to the session's own totals. `PendingUsagePool` (`src/usage.ts`) accumulates usage, and `withUsageReporting` attaches the drained total to the next result of `agent`, `get_subagent_result`, `steer_subagent`, and `stop_subagent`. The extension's own displays leave out `cacheRead`, but the reported total includes it.

## Decision

With `reportUsage` on, subagent usage reaches pi's totals as a `usage` field on tool results. With it off, the extension adds nothing.

- The extension reports every token component, `cacheRead` included, so a subagent's rows count the way the session's own rows do. The extension's own token displays measure something else and keep omitting `cacheRead`.
- Cost is pi's per-message figure from the model's listed rates. A model with no rates contributes zero, never an estimate.
- The extension reports usage from nested agents at any depth, once.
- The extension attaches usage to the next tool result. It counts an agent that finishes in the background on the result after that. A result with no `toolCallId` gets none.
- Turning the setting off drains and discards the pool.
- pi derives the context-window percentage from assistant messages alone, so this setting does not change it.

Done check: `npx vitest run test/usage.test.ts test/usage-reporting.test.ts` passes. It covers each component, the zero-cost case, the drain on disable, and the attach points.

## Consequences

- Usage can lag a result by one call, and usage from agents that never produce another tool result never reaches the totals.
- Turning it on mid-session reports only what accrues after.
- Revisit if pi gains an API for external spend, which would replace result-borne usage.
