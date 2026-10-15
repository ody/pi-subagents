> DRAFT: not accepted, not current truth.

# NNNN. Source files are split along cohesion seams, with size as a trigger

## Context

`src/index.ts` is 3504 lines and about 170 KB, and one factory function holds tool registration, the `/agents` menus, settings and notification logic over shared closure state. An agent's `Read` truncates at 50 KB, so editing it takes chunked reads, long anchors and whole-file rewrites. Large files also hide coupling. `src/agent-manager.ts` and `src/agent-runner.ts` are above 1000 lines each.

A bare line limit invites bad fixes: arbitrary `part2.ts` splits, dumping grounds named `utils.ts`, one-call helpers, or packing code into long lines to fit. Each meets the number and makes the code harder to follow.

## Decision

Size limits are triggers to look at a file, never targets to hit. The goal is that each file is easy to reason about and can be read whole.

- A `src/` file over 500 lines needs a reason in one sentence in its header comment, or a split.
- A `src/` file must stay under 800 lines and 40 KB. `test/file-size.test.ts` enforces this, with an allowlist of existing offenders pinned at their current line count. An entry may shrink or be removed, never grow.
- Function size is judged by nesting and the number of things in scope, not by lines. A long flat sequence, such as a list of registrations, is fine. Deeply nested closures are not.
- Biome's `complexity/noExcessiveCognitiveComplexity` at its default of 15 is the trigger. It is enabled at `info` severity, so it reports and never fails `npm run check`. A report means read the function and decide, not shorten it to silence the rule.

Split along a seam that already exists, and only when the new module passes these checks:

- One reason to change, stated in a sentence without "and".
- A name that says what it does, such as `agents-menu.ts`. Never `utils.ts`, `helpers.ts`, `misc.ts` or `part2.ts`.
- A narrow interface. Shared state passes in an explicit deps object holding only what the module uses. A deps object that keeps growing means the seam is wrong.
- Pure logic apart from pi-coupled code, as `src/ui/agent-tree.ts` is. Pure modules get direct unit tests.
- Imports point one way. No cycles. A helper that two modules need goes in a leaf module, as `src/xml.ts` did.

Never do these to meet a limit:

- Split a cohesive unit in the middle.
- Extract a fragment with one caller and no name of its own. This also breaks the AGENTS.md rule to inline single-line helpers with one call site.
- Add barrel files or re-export shims.
- Shorten code by lengthening lines, deleting blank lines or comments, or writing dense one-liners.

A split changes no behavior. It moves code, updates imports and moves the matching tests, in one commit with no other change. `index.ts` ends up as wiring: it builds shared state and calls `registerX(pi, deps)` from per-concern modules.

A tracked `.githooks/pre-commit` runs only the structure checks, never the full test suite:

- `npx vitest run test/file-size.test.ts`, which fails the commit on a size violation.
- `biome lint --only=complexity/noExcessiveCognitiveComplexity` on the staged `src/` files, which prints its `info` reports and never fails the commit.

A `prepare` script in `package.json` sets `core.hooksPath` to `.githooks`. Agents never edit git config or skip the hook with `--no-verify`.

Done check: `npm run check` passes, including `test/file-size.test.ts`, and `npx vitest run test/file-size.test.ts` passes alone.

Rejected: Biome's `noExcessiveLinesPerFunction`, because it rewards fragmenting. Rejected: making the complexity rule an error, because it would fail on existing functions. Rejected: guidance in `AGENTS.md` alone, because nothing enforces it. Rejected: running the full suite or CI-style checks in the hook, because the hook is scoped to structure and a slow hook gets bypassed.

## Consequences

The ratchet makes oversized files visible in CI and stops them growing, without forcing a rewrite. Splitting `index.ts` is separate backlog work. Revisit the numbers if the `Read` truncation limit changes, or if a split produces modules that need wide deps objects.
