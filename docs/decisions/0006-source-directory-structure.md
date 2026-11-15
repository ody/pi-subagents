# 0006. Concern directories, not layers, group source files

## Context

A flat source tree makes placement the default rather than a choice. A new file lands beside the entry point whatever it does, and the tree shows nothing about the design.

ADR 0004 decides when to split a file and how large it may grow. It does not say where a file lives.

Directories as layers do not hold, because the first module that needs a type from the "wrong" side breaks an import-direction rule. Ownership of a concern is the stable basis for grouping.

## Decision

A `src/` file lives in the directory named for the one concern it serves, and a module test lives in the matching `test/` directory. The set of directories is not fixed by this record. It follows the concerns the code has.

A group is valid when it passes these checks:

- One reason to change, stated in a sentence without "and".
- A name for what it owns, such as `agents/` or `ui/`. Never `core/`, `utils/`, `helpers/`, `misc/` or `part2/`. A directory named for nothing collects every file nobody would place.
- At least two files. A directory holding one file names nothing, so that file stays at the root.

`src/` placement:

- `src/` root holds the extension entry and code no single group owns. A file one group owns belongs in that group.
- A file that could fit two groups goes to the group with the largest number of modules importing it. If the counts tie, including zero, it stays at the `src/` root until one group clearly owns it.
- Groups name ownership, not layers. Imports may point any direction, and no import-direction rule or barrel file applies. ADR 0004's no-cycles rule stays per-module.
- No document lists `src/` files. The tree is the map.

`test/` placement:

- A test named for a `src/` module lives in the `test/` directory named for that module's group. A test of a `src/` root module stays at the `test/` root.
- Any other test goes to the group it imports the most `src/` modules from. If the counts tie, including zero, it stays at the `test/` root.
- An end-to-end test lives in `test/e2e/`, whatever module it guards.
- Tests of the repository itself, such as file size and source tree, stay at the `test/` root.
- Other support directories hold fixtures, test harness code and performance checks. Name each for what it holds, never for a `src/` group.
- A group directory in `test/` needs no second file, because the `src/` group already names it.

Create or change a group when a new file shares a concern with existing files. Also change it when its name stops describing its files. Moving files updates imports and tests in one commit with no other change, per ADR 0004. Moving a `src/` file between groups moves its test in the same commit.

Done check:

- No `src/` or `test/` directory, at any depth, has the name `core`, `utils`, `helpers`, `misc` or `part2`.
- Every top-level `src/` group and every `test/` support directory holds at least two files, counted at any depth.
- Every test named for a `src/` module sits in the `test/` directory of that module's group.
- `test/source-tree.test.ts` enforces the checks above.

Rejected:

- A fixed list of directories in this record. It goes stale with the first new concern and then needs a new ADR.
- Directories as layers with import-direction rules. Imports follow ownership, not a fixed order.
- A hand-kept file map in `README.md`. It duplicates the tree, drifts with every move, and needs a test to keep it true.
- One directory per `README.md` section. A section grouped by role mixes concerns that change for different reasons.
- A flat `test/` root. It repeats the flat-tree problem in the Context, and a long list of test files hides which module each one guards.
- Review alone. Nothing detects the next misplaced file. ADR 0004 rejected guidance in `AGENTS.md` alone for the same reason.

## Consequences

A file with no obvious home is not a reason for a new group. It belongs in the group whose concern it serves, or that group's name is wrong.

The test cannot judge whether a group's concern is coherent, or which group a test imports the most from. Both stay with review, as ADR 0004's seam checks do. Revisit if a group grows past what one directory carries, since it may split along a seam it already has.
