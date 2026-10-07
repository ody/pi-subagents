# Development Rules

## Decision records and backlog

- `docs/decisions/*.md` is current truth. Follow it. Ignore `docs/decisions/drafts/` unless asked to work on a draft.
- Format, drafts, and superseding: [ADR 0001](docs/decisions/0001-decision-records.md).
- Backlog: GitHub issues at `github.com/ody/pi-subagents`, driven with `gh` and the `gh` skill. Labels: `task`, `bug`, `chore`.

## Rules index

Each entry: the rule an agent must not break, and its ADR.

- **Upstream.** Hard fork as `@ody/pi-subagents`: never merge, rebase onto, cherry-pick from, or add a remote for `tintinweb/pi-subagents`, and never keep code, docs, or tests for upstream compatibility. [ADR 0002](docs/decisions/0002-hard-fork-from-upstream.md)

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
- This is a pi extension. Respect the Claude Code-compatible tool names, calling conventions, and UI patterns the extension deliberately mirrors; don't diverge from them without a stated reason.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Documentation

Read the file that covers a surface before changing its behavior; update it in the same change.

| File | Covers |
| --- | --- |
| `README.md` | User-facing reference: features, install, tool parameter tables, commands, settings and defaults, the event table, the RPC channel list, and the `src/` file map (`## Architecture`). Source of truth for defaults and setting names. |
| `docs/workflows.md` | `SubagentWorkflow` in depth — how the model writes a script, editing and re-running it, saving a named workflow, `agent()` options, recipes, troubleshooting. Examples in `examples/workflows/`. |
| `docs/rpc.md` | Calling this extension from another pi extension — `pi.events` lifecycle events (`subagents:completed`, `subagents:ready`, …), the `subagents:rpc:*` channels (`ping`, `spawn`, `stop`, `consume`), spawn options, error strings, and the `Symbol.for("pi-subagents:manager")` registry. Source: `src/cross-extension-rpc.ts`. |
| `CONTRIBUTING.md` | Contributor guidelines and quality bar. |
| `SECURITY.md` | Vulnerability reporting. |

`README.md` holds the reference tables and links out; `docs/` holds the long-form guides. Each guide states its audience in its first three lines — read that before deciding it is the wrong file. Renaming an event, an RPC channel, a reply-envelope field, or a workflow global is a docs change too.

## Changelog

Location: `CHANGELOG.md` (single file, [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format).

- All new entries go under `## [Unreleased]`, in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`, `### Refactored`). Read the section first and append to existing subsections; never duplicate them.
- One bullet per issue/PR. Never combine separate issues or pull requests into a single entry, even when they touch the same or similar components. (A PR together with the issue it closes or that diagnosed it is one change — one bullet citing both.)
- Breaking changes are not a separate subsection. Call them out with a `> **⚠️ Breaking: …**` blockquote at the top of the version section, and/or a bold `**BREAKING:**` bullet under `### Changed`, with a migration note.
- Entries are concise — a bold lead-in stating what changed, then a sentence or two on why it changed and anything a user must do about it. Aim for 2–4 sentences; a change with many moving parts may run longer, but length is never the goal. Do not match the density of older entries, several of which are far too long.
- Cut what the reader doesn't need: narration of the investigation, alternatives considered and rejected, restatements of the diff, and detail recoverable from the code or the linked issue. Name a file or symbol only when it helps someone find the change.
- Released version sections (e.g. `## [0.12.0]`) are immutable; never modify them.
- Attribute external contributions: `... ([#456](https://github.com/tintinweb/pi-subagents/pull/456) — thanks [@username](https://github.com/username))`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
