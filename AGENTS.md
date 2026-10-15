# AGENTS.md

pi extension providing sub-agents (`Agent` tool, `/agents` menu), packaged as `@ody/pi-subagents`. TypeScript, vitest, biome.

## Decision records and backlog

- `docs/decisions/*.md` is current truth. Follow it. Ignore `docs/decisions/drafts/` unless asked to work on a draft.
- Format, drafts, and superseding: [ADR 0001](docs/decisions/0001-decision-records.md).
- Backlog: GitHub issues at `github.com/ody/pi-subagents`, driven with `gh` and the `gh` skill. Labels: `task`, `bug`, `chore`.

## Rules index

Each entry: the rule an agent must not break, and its ADR.

- **Upstream.** Hard fork: never merge, rebase onto, cherry-pick from, or add a remote for the upstream repository, and never keep or shape code, docs, or tests for upstream or Claude Code compatibility. [ADR 0002](docs/decisions/0002-hard-fork-from-upstream.md)
- **No workflows.** Never add workflow orchestration to this repo, and never change `subagents:rpc:*` channels or lifecycle events for top-level agents while removing it. [ADR 0003](docs/decisions/0003-no-workflow-orchestration.md)
- **File structure.** Split source files along cohesion seams, never to hit a number. Over 500 lines needs a `Size:` header reason, and 800 lines or 40 KB is the cap. Never create `utils.ts`, `part2.ts` or one-caller fragments, and never compress code to fit. [ADR 0004](docs/decisions/0004-source-file-structure.md)
- **Git hooks.** Pre-commit checks live in tracked `.githooks/` and stay fast. Never run the full suite in the hook, skip it with `--no-verify`, or edit git config. [ADR 0005](docs/decisions/0005-git-hooks.md)

## Commands

- Full check before finishing: `npm run check` (biome lint, `tsc --noEmit`, vitest).
- One test file: `npx vitest run test/<name>.test.ts`. Prefer this over the whole suite while iterating.
- E2E only: `npm run test:e2e`.
- Fix lint: `npm run lint:fix`.
- Try the extension from a checkout: `pi -e ./src/index.ts`.

## Code style

- Biome's formatter is off. Match the surrounding code. Biome lint is the only style enforcement.
- File size is enforced by `test/file-size.test.ts`. [ADR 0004](docs/decisions/0004-source-file-structure.md)
- No `any` unless unavoidable.
- Top-level imports only. No `await import()` and no `import("pkg").Type`.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for types from `@earendil-works/pi-*` and `@sinclair/typebox`. Do not guess them.
- If a type error comes from an outdated dependency, upgrade it. Do not remove or downgrade code to make it compile.
- Do not preserve backward compatibility unless asked.

## Dependencies

- Packages pi provides at runtime (`@earendil-works/pi-*`, `typebox`, `@sinclair/typebox`) go in `peerDependencies`, never `dependencies`. A copy under `dependencies` can load a second runtime module and break schema and `instanceof` checks.
- `typebox` and `@sinclair/typebox` peers use `"*"`. `@earendil-works/pi-*` peers use `>=1.0.0`.
- The pi floor is `>=1.0.0` by choice: nothing older is tested. Never add shims, version gates, or comments for pi below it. Revisit when CI returns.
- Pinned copies for typecheck and tests go in `devDependencies`, at or above the floor.
- Third-party runtime packages pi does not provide stay in `dependencies`.

## Testing

- Add or update tests for the behavior you change.
- A test that loses its purpose because the code it guards is gone gets deleted, not bent to fit.
- `vitest.config.ts` inlines `@earendil-works/pi-*` so the faux-provider e2e tests share one pi-ai instance. Do not remove that setting.

## Documentation

Update the doc in the same change as the behavior.

- `README.md`: features, install, tool parameters, commands, settings and defaults, event table, and the `src/` file map. It is the source of truth for defaults and setting names.
- `docs/rpc.md`: `pi.events` lifecycle events and the `subagents:rpc:*` channels. Renaming an event, channel, or reply field is a docs change.
