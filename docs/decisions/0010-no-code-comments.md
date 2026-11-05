# 0010. Source and test files carry no comments

## Context

`src/` and `test/` hold about 4,800 and 3,800 lines that start with a comment marker (`//`, `/*`, `*`). 75 of the `src/` files carry them, with 730 `/**` blocks, and 58 lines reference issue numbers. All 27 distinct numbers are inherited from the upstream tracker: this repo's issues end at #46, and the one number in that range, `#38`, names an unrelated issue here.

A comment is a second statement of what the code does or why. Nothing checks it against the code, the ADRs, `README.md` or `docs/rpc.md`, so it drifts, and an agent reading it cannot tell a stale comment from a true one.

Comments also cost context on every `Read`, and they invite the file-size workarounds that [ADR 0004](0004-source-file-structure.md) already forbids.

## Decision

Files under `src/` and `test/` contain no comments. Behavior is stated by names, types and test titles. A rule an agent must follow goes in an ADR. The reason for one change goes in its commit message. A setting's name and default go in `README.md`, and an event or RPC field goes in `docs/rpc.md`.

Three comment forms are exempt because a tool reads them:

- `Size: <reason>` header line required by [ADR 0004](0004-source-file-structure.md).
- `biome-ignore <rule>: <reason>` directives, whose reason [ADR 0004](0004-source-file-structure.md) requires.
- A `#!` shebang on the first line.

Never add a new exempt form. A comment to explain surprising code means the code needs a better name, a smaller function, or a test that pins the behavior. Never replace a removed comment with a string constant, an unused variable or any other carrier of the same prose.

`test/no-comments.test.ts` enforces this. It parses every `.ts` file under `src/` and `test/` with the TypeScript scanner, so `//` inside a string or template literal is not a comment, and it fails on any comment outside the exempt forms.

Agents learn the rule from `AGENTS.md`, not from this ADR. `AGENTS.md` carries a rules-index entry and a `Code style` bullet for it.

Biome has no rule that flags arbitrary comments, so the test is the lint gate. `npm run check` runs it, and `.githooks/pre-commit` runs it beside the size and complexity tests, as [ADR 0005](0005-git-hooks.md) allows for fast structure checks.

Done check:

- `npx vitest run test/no-comments.test.ts` passes.
- `.githooks/pre-commit` names `test/no-comments.test.ts`.

Rejected: keeping "why" comments only, because "why" versus "what" is a judgment no test can enforce and the "why" drifts too. Rejected: keeping JSDoc on exported symbols, because `README.md` and `docs/rpc.md` own the public surface.

## Consequences

Rationale that lives only in a comment today is lost unless its owner moves it to an ADR, a commit message or a test first. The issue references lose nothing, since none resolves in this repo. `git blame` plus the commit message take over.

Revisit if a recurring class of surprising code cannot be made clear by naming or tests, or if a tool starts to read another comment form.

The hook command in [ADR 0005](0005-git-hooks.md) gains the new test when the test lands.

The test cannot land before the strip. Land them in one change, or start the test with a ratchet allowlist like `test/file-size.test.ts` that pins each file's comment count and may only shrink.
