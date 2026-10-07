# Development Rules

## Decision records and backlog

- `docs/decisions/*.md` is current truth. Follow it. Ignore `docs/decisions/drafts/` unless asked to work on a draft.
- Format, drafts, and superseding: [ADR 0001](docs/decisions/0001-decision-records.md).
- Backlog: GitHub issues at `github.com/ody/pi-subagents`, driven with `gh` and the `gh` skill. Labels: `task`, `bug`, `chore`.

## Rules index

Each entry: the rule an agent must not break, and its ADR.

- **Upstream.** Hard fork as `@ody/pi-subagents`: never merge, rebase onto, cherry-pick from, or add a remote for the upstream repository, and never keep or shape code, docs, or tests for upstream or Claude Code compatibility. [ADR 0002](docs/decisions/0002-hard-fork-from-upstream.md)

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types (`@earendil-works/pi-*`, `@sinclair/typebox`, etc.); don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Match the surrounding code style — it is enforced by biome (`biome.json`).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Documentation

Read the file that covers a surface before changing its behavior; update it in the same change.

| File | Covers |
| --- | --- |
| `README.md` | User-facing reference: features, install, tool parameter tables, commands, settings and defaults, the event table, the RPC channel list, and the `src/` file map (`## Architecture`). Source of truth for defaults and setting names. |
| `docs/workflows.md` | `SubagentWorkflow` in depth — how the model writes a script, editing and re-running it, saving a named workflow, `agent()` options, recipes, troubleshooting. Examples in `examples/workflows/`. |
| `docs/rpc.md` | Calling this extension from another pi extension — `pi.events` lifecycle events (`subagents:completed`, `subagents:ready`, …), the `subagents:rpc:*` channels (`ping`, `spawn`, `stop`, `consume`), spawn options, error strings, and the `Symbol.for("pi-subagents:manager")` registry. Source: `src/cross-extension-rpc.ts`. |

`README.md` holds the reference tables and links out; `docs/` holds the long-form guides. Each guide states its audience in its first three lines — read that before deciding it is the wrong file. Renaming an event, an RPC channel, a reply-envelope field, or a workflow global is a docs change too.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
