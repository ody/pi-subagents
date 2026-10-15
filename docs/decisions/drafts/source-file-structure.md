> DRAFT: not accepted, not current truth.

# NNNN. Source files are split along cohesion seams, with size as a trigger

## Context

`src/index.ts` is several times the 50 KB limit of an agent's `Read` call, and one factory function holds tool registration, menus, settings and notification logic over shared closure state. Editing it takes chunked reads, long anchors and whole-file rewrites. Large files also hide coupling.

A bare line limit invites bad fixes: arbitrary `part2.ts` splits, dumping grounds named `utils.ts`, one-call helpers, or packing code into long lines to fit. Each meets the number and makes the code harder to follow.

## Decision

Size limits are triggers to look at a file, never targets to hit. The goal is that each file is easy to reason about and can be read whole.

- A `src/` file over 500 lines needs a header comment line `Size: <one-sentence reason>`, or a split.
- A `src/` file must stay under 800 lines and 40 KB.
- `test/file-size.test.ts` enforces both rules. Existing offenders sit in an allowlist that pins each file's line count and byte size. Neither may grow. An entry may shrink or be removed.
- Function size is judged by Biome's `complexity/noExcessiveCognitiveComplexity` at its default of 15, enabled at `info` severity. It reports and never fails `npm run check`. A long flat sequence, such as a list of registrations, is fine.
- A report means read the function and decide. Record a function judged acceptable with `// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <reason>`. Never shorten code only to silence the rule.

Split along a seam that already exists, and only when the new module passes these checks:

- One reason to change, stated in a sentence without "and".
- A name that says what it does, such as `agents-menu.ts`. Never `utils.ts`, `helpers.ts`, `misc.ts` or `part2.ts`.
- A narrow interface. Shared state passes in an explicit deps object holding only what the module uses. A deps object that keeps growing means the seam is wrong.
- Pure logic apart from pi-coupled code, as `src/ui/agent-tree.ts` is. Pure modules get direct unit tests.
- Imports point one way. No cycles. A helper that several modules need goes in a leaf module.

Never do these to meet a limit:

- Split a cohesive unit in the middle.
- Extract a fragment with one caller and no name of its own.
- Add barrel files or re-export shims.
- Shorten code by lengthening lines, deleting blank lines or comments, or writing dense one-liners.

A split changes no behavior. It moves code, updates imports, moves the matching tests and updates the `src/` file map in `README.md`, in one commit with no other change. New per-concern code goes in a module that exposes `registerX(pi, deps)`, and `index.ts` only wires.

Done check:

- `npm run check` passes, including `test/file-size.test.ts`.
- `biome.json` sets `linter.rules.complexity.noExcessiveCognitiveComplexity` to `"info"`.

Rejected: Biome's `noExcessiveLinesPerFunction`, because it rewards fragmenting. Rejected: making the complexity rule an error, because it would fail on existing functions. Rejected: guidance in `AGENTS.md` alone, because nothing enforces it.

## Consequences

The ratchet makes oversized files visible and stops them growing, without forcing a rewrite. Splitting `index.ts` is separate backlog work. Revisit the numbers if the `Read` truncation limit changes, or if a split produces modules that need wide deps objects.
