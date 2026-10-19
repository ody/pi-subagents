> DRAFT: not accepted, not current truth.

# NNNN. Source files live in concern directories, not layers

## Context

A flat source tree makes placement the default rather than a choice. A new file lands beside the entry point whatever it does, and the tree shows nothing about the design.

ADR 0004 decides when to split a file and how large it may grow. It does not say where a file lives.

Directories as layers do not hold. Groups of modules depend on each other in both directions, so an import-direction rule would be broken as soon as it was written. Ownership of a concern is the stable basis for grouping.

## Decision

Every `src/` file lives in the directory named for the one concern it serves.

| Directory | One reason to change |
| --- | --- |
| `agents/` | the catalog of agent definitions and their precedence rules |
| `session/` | how a single child session is constructed and executed |
| `manager/` | what happens to an agent record between spawn and eviction |
| `tool/` | the tool surface the model sees, including the tools handed to a child |
| `triggers/` | how a non-tool caller starts an agent |
| `config/` | how a run's settings and model are resolved |
| `platform/` | the process and filesystem it runs against |
| `ui/` | TUI surfaces |

- `src/` root holds only the extension entry and cross-cutting vocabulary: `index.ts`, `types.ts`, `usage.ts` and `lifecycle-events.ts`. A file one group owns belongs in that group.
- A file that could fit two groups goes to the group whose modules import it most.
- Groups name ownership, not layers. Imports may point any direction, and no import-direction rule or barrel file applies. ADR 0004's no-cycles rule stays per-module.
- Module tests sit at the `test/` root and mirror no group. Subdirectories of `test/` hold support material: end-to-end tests, fixtures, helpers and performance checks.
- Never create `core/`, `utils/`, `helpers/`, `misc/` or `part2/` under `src/`. A directory named for nothing collects every file nobody would place.
- ADR 0004's per-file rules apply inside every group.
- The `src/` map in `README.md` assigns each file to its group. This record lists no files.

Done check:

- `ls src/*.ts` prints only `index.ts`, `types.ts`, `usage.ts` and `lifecycle-events.ts`.
- Every other path under `src/` is `src/<group>/<file>.ts` for a group in the table.
- No `core/`, `utils/`, `helpers/`, `misc/` or `part2/` exists under `src/`.
- The `src/` map in `README.md` lists every file under `src/`, and every path it lists exists.
- `test/source-tree.test.ts` enforces the four checks above.

Rejected:

- Directories as layers with import-direction rules. Groups import each other in both directions.
- One directory per `README.md` section. A section grouped by role mixes concerns that change for different reasons.
- Mirroring `test/` into the same groups. Module tests are named after the module they guard, and mirroring doubles the cost of every move.
- Review alone. Nothing detects the next file dropped at `src/` root, which is the same reason ADR 0004 rejected guidance in `AGENTS.md` alone.

## Consequences

Adding, renaming or removing a group changes this decision. It is never the fix for one file with no obvious home: that file belongs in the group whose concern it serves, or the group's name is wrong.

Revisit if a group grows past what one directory carries, since it may split along a seam it already has. Revisit if the module graph loses its cycles, since layers would then be available.
