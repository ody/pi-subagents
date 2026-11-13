# 0026. An unqualified agent call runs in the background

## Context

`backgroundByDefault` (default `true`) decides what an `agent` call means when neither the caller nor the agent file says. ADR 0014 sets the precedence and lists the setting as the fallback for `run_in_background`, and ADR 0023 applies it to ephemeral agents.

A background agent returns its id at once and reports through a completion notification. The notification path exists only for top-level agents (ADR 0007). The manager aborts a nested child when its parent settles, so a detached nested child would never report.

## Decision

The top-level `agent` tool's fallback for `run_in_background` is `backgroundByDefault`, and the default is `true`.

- Turning it off restores blocking, inline results for unqualified calls. A caller parameter or an agent file's frontmatter overrides it in both directions.
- The nested `agent` tool never reads the setting. Its unspecified calls are foreground.
- The setting applies live and does not change an agent already running. A change registers the `agent` tool again, so the `run_in_background` description states the new default.
- The background pool (`maxConcurrent`) and the foreground pool (`maxConcurrentForeground`) are separate. The setting only chooses which pool an unspecified call uses.

Done check: `npx vitest run test/background-by-default.test.ts test/invocation-config.test.ts test/nested-tools.test.ts` passes. It covers both setting values, both overrides, and the nested foreground default.

## Consequences

- A model that does not know about background runs gets an id instead of a result, and must call `get_subagent_result` or wait for the notification.
- Revisit if the notification path extends to nested agents.
