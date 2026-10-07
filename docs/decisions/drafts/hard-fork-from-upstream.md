> DRAFT: not accepted, not current truth.

# NNNN. Hard fork from tintinweb/pi-subagents as @ody/pi-subagents

## Context

This repo began as a soft fork of `tintinweb/pi-subagents` 0.19.0 with local commits on top. Upstream identity is still everywhere: `package.json` names `@tintinweb/pi-subagents` with tintinweb `author`, `repository`, `homepage`, and `bugs` URLs, and `README.md`, `CHANGELOG.md`, and `docs/rpc.md` link upstream issues and PRs. Upstream contributor policy (`CONTRIBUTING.md`, `SECURITY.md`, `.github/FUNDING.yml`) does not apply here. Tracking upstream costs merge effort and keeps code and docs this project does not want.

## Decision

This repo is a hard fork. It never merges, rebases onto, or cherry-picks from `tintinweb/pi-subagents`, and never adds it as a git remote. Upstream compatibility is not a reason to keep code, docs, or behavior.

Identity in `package.json`:

- `name` is `@ody/pi-subagents`. The short name `pi-subagents` stays, so the `pi-subagents:` event and RPC prefixes and `Symbol.for("pi-subagents:manager")` are unchanged.
- `version` resets to `0.1.0`.
- `author` is `ody`. `repository`, `homepage`, and `bugs` point at `github.com/ody/pi-subagents`.
- `"private": true`. `publishConfig` and the `prepublishOnly` script are removed. Install is from git or a local path only.
- `pi.video` and `pi.image` are removed.

`LICENSE` keeps `Copyright (c) 2026 tintinweb`, as MIT requires, and adds an `ody` copyright line below it.

Delete these tracked files:

- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`
- `examples/agent-tool-description.md`, with the test that reads it: "the shipped example template renders byte-identical to the full description" and the `EXAMPLE_TEMPLATE` constant in `test/tool-description-mode.test.ts`
- `.pi/agents/auditor.md`
- `.github/FUNDING.yml`
- `media/`
- `.npmignore`, since nothing is published

A test that breaks or loses its purpose because of these changes is deleted, not adapted to keep the old behavior. Tests that only change because of the rename, such as the `@tintinweb/pi-subagents` fixture strings in `test/agent-runner.test.ts`, are updated to `@ody/pi-subagents`.

The only Markdown kept outside test fixtures is `AGENTS.md`, `README.md`, `docs/rpc.md`, `docs/workflows.md`, and `docs/decisions/`.

Rebuild `AGENTS.md` and `README.md` for the fork:

- `AGENTS.md` drops the `Changelog` section and the `CONTRIBUTING.md` and `SECURITY.md` rows. The Claude Code-compatibility rule stays until an ADR changes it.
- `README.md` drops upstream install instructions, links, issue references, and media, and documents git or local install.
- `docs/rpc.md` and `docs/workflows.md` drop upstream issue and PR links.

The fork is complete when `git grep -n -i -E 'tintinweb/pi-subagents|@tintinweb/' -- ':!LICENSE' ':!docs/decisions'` prints nothing and `npm run lint`, `npm run typecheck`, and `npm test` pass.

## Consequences

- Upstream fixes no longer arrive. Each one wanted is reimplemented by hand.
- `git log` is the only change history. Reintroducing a changelog needs its own ADR.
- Publishing again means removing `"private"` and choosing a registry name first.
