# 0005. Tracked git hooks run fast structure checks

## Context

The repo has no CI, so nothing runs `npm run check` unless someone remembers. `.git/hooks` is not versioned, and `AGENTS.md` forbids agents from editing git config or skipping hooks. The full test suite takes about 25 seconds, and a slow hook gets bypassed.

## Decision

Checks that must run before a commit live in a tracked `.githooks/pre-commit`. The hook stays fast and never runs the full test suite.

- `.githooks/pre-commit` is executable and tracked.
- A `prepare` script in `package.json` sets `core.hooksPath` to `.githooks`. It must not fail an install outside a git checkout: `git rev-parse --git-dir >/dev/null 2>&1 && git config core.hooksPath .githooks || true`.
- The hook runs `npx vitest run test/file-size.test.ts test/complexity.test.ts`, which fails the commit on a size or complexity-ceiling violation.
- The hook runs `npx biome lint --staged --only=complexity/noExcessiveCognitiveComplexity`. It prints its `info` reports and never fails the commit.
- Agents never skip the hook with `--no-verify` and never edit git config. `npm install` sets the hooks path.

Done check:

- `.githooks/pre-commit` is tracked and executable.
- `package.json` has a `prepare` script that sets `core.hooksPath`.
- After `npm install` in a checkout, `git config core.hooksPath` prints `.githooks`.

Rejected: running the full suite in the hook, because it is slow enough to get bypassed. Rejected: restoring CI, because the repo dropped it on purpose.

## Consequences

Commits take a few extra seconds. A new check belongs in the hook only if it is fast and scoped. Revisit when CI returns, since checks may move there.
