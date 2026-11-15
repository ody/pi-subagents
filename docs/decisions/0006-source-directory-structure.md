# 0006. Concern directories, not layers, group source files

## Context

A flat source tree makes placement the default rather than a choice. A new file lands beside the entry point whatever it does, and the tree shows nothing about the design.

ADR 0004 decides when to split a file and how large it may grow. It does not say where a file lives.

Directories as layers do not hold, because the first module that needs a type from the "wrong" side breaks an import-direction rule. Ownership of a concern is the stable basis for grouping.

## Decision

A `src/` file lives in the directory named for the one concern it serves. The set of directories is not fixed by this record. It follows the concerns the code has.

The naming and size checks below also apply to every subdirectory of `test/`, at any depth. The placement rules apply to `src/` only.

A group is valid when it passes these checks:

- One reason to change, stated in a sentence without "and".
- A name for what it owns, such as `agents/` or `ui/`. Never `core/`, `utils/`, `helpers/`, `misc/` or `part2/`. A directory named for nothing collects every file nobody would place.
- At least two files. A directory holding one file names nothing, so that file stays at the root.

Placement rules:

- `src/` root holds the extension entry and code no single group owns. A file one group owns belongs in that group.
- A file that could fit two groups goes to the group with the largest number of modules importing it. If the counts tie, including zero, it stays at the `src/` root until one group clearly owns it.
- Groups name ownership, not layers. Imports may point any direction, and no import-direction rule or barrel file applies. ADR 0004's no-cycles rule stays per-module.
- Module tests sit at the `test/` root and mirror no group. Subdirectories of `test/` hold support material: end-to-end tests, fixtures, test harness code and performance checks. Each is named for what it holds, never `helpers`.
- ADR 0004's per-file rules apply inside every group.
- No document lists `src/` files. The tree is the map.

Create or change a group when a new file shares a concern with existing files. Also change it when its name stops describing its files. Moving files updates imports and tests in one commit with no other change, per ADR 0004.

Done check:

- No `src/` or `test/` subdirectory has the name `core`, `utils`, `helpers`, `misc` or `part2`.
- Every `src/` and `test/` subdirectory holds at least two files.
- `test/source-tree.test.ts` enforces the two checks above.

Rejected:

- A fixed list of directories in this record. It goes stale with the first new concern and then needs a new ADR.
- Directories as layers with import-direction rules. Imports follow ownership, not a fixed order.
- A hand-kept file map in `README.md`. It duplicates the tree, drifts with every move, and needs a test to keep it true.
- One directory per `README.md` section. A section grouped by role mixes concerns that change for different reasons.
- Mirroring `test/` into the same groups. Each module test takes the name of the module it guards, and mirroring doubles the cost of every move.
- Review alone. Nothing detects the next misplaced file. ADR 0004 rejected guidance in `AGENTS.md` alone for the same reason.

## Consequences

A file with no obvious home is not a reason for a new group. It belongs in the group whose concern it serves, or that group's name is wrong.

The test cannot judge whether a group's concern is coherent. That stays with review, as ADR 0004's seam checks do. Revisit if a group grows past what one directory carries, since it may split along a seam it already has.
