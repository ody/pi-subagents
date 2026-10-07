# AGENTS.md

pi extension providing sub-agents (`Agent` tool, `/agents` menu) and scripted workflow orchestration (`SubagentWorkflow`), packaged as `@ody/pi-subagents`. TypeScript, vitest, biome.

## Decision records and backlog

- `docs/decisions/*.md` is current truth. Follow it. Ignore `docs/decisions/drafts/` unless asked to work on a draft.
- Format, drafts, and superseding: [ADR 0001](docs/decisions/0001-decision-records.md).
- Backlog: GitHub issues at `github.com/ody/pi-subagents`, driven with `gh` and the `gh` skill. Labels: `task`, `bug`, `chore`.

## Rules index

Each entry: the rule an agent must not break, and its ADR.

- **Upstream.** Hard fork: never merge, rebase onto, cherry-pick from, or add a remote for the upstream repository, and never keep or shape code, docs, or tests for upstream or Claude Code compatibility. [ADR 0002](docs/decisions/0002-hard-fork-from-upstream.md)

## Commands

- Full check before finishing: `npm run check` (biome lint, `tsc --noEmit`, vitest).
- One test file: `npx vitest run test/<name>.test.ts`. Prefer this over the whole suite while iterating.
- E2E only: `npm run test:e2e`.
- Fix lint: `npm run lint:fix`.
- Try the extension from a checkout: `pi -e ./src/index.ts`.

## Code style

- Biome's formatter is off. Match the surrounding code; biome lint is the only enforcement.
- No `any` unless unavoidable.
- Top-level imports only. No `await import()` and no `import("pkg").Type`.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for types from `@earendil-works/pi-*` and `@sinclair/typebox`. Do not guess them.
- If a type error comes from an outdated dependency, upgrade it. Do not remove or downgrade code to make it compile.
- Do not preserve backward compatibility unless asked.

## Testing

- Add or update tests for the behavior you change.
- A test that loses its purpose because the code it guards is gone gets deleted, not bent to fit.
- `vitest.config.ts` inlines `@earendil-works/pi-*` so the faux-provider e2e tests share one pi-ai instance. Do not remove that setting.

## Documentation

Update the doc in the same change as the behavior.

- `README.md`: features, install, tool parameters, commands, settings and defaults, event table, and the `src/` file map. It is the source of truth for defaults and setting names.
- `docs/workflows.md`: `SubagentWorkflow` usage. Examples live in `examples/workflows/` and are run by tests.
- `docs/rpc.md`: `pi.events` lifecycle events and the `subagents:rpc:*` channels. Renaming an event, channel, reply field, or workflow global is a docs change.
