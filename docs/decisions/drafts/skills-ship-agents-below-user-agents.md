> DRAFT: not accepted, not current truth.

# NNNN. Skills ship agents that rank below every user agent

## Context

A skill that needs work done in a clean context has to dispatch a sub-agent. Without a way to ship the agent with the skill, every user must install the agent file by hand, and the skill breaks when they have not.

Skill directories are often read-only package-manager or Nix store paths, and are frequently symlink farms. pi itself finds skills as any directory holding a `SKILL.md`, at any depth, following symlinks.

`loadSkillAgents` in `src/custom-agents.ts` scans only `$PI_CODING_AGENT_DIR/skills/`. Project skill directories and skills pi loads from packages are not scanned.

## Decision

A skill ships agents as `.md` files in an `agents/` directory next to its `SKILL.md`. They load with `source: "skill"`.

Precedence, highest first:

1. `.pi/agents/` (project)
2. `.agents/agents/` (project workspace)
3. `$PI_CODING_AGENT_DIR/agents/` (global)
4. Skill agents
5. Built-in defaults

Rules:

- Any user file overrides a skill agent of the same name. A skill agent overrides a built-in default.
- Skill discovery matches pi's: a directory with `SKILL.md` is a skill, dot entries and `node_modules` are skipped, and a skill is not searched for nested skills. Symlinks are followed, with a realpath set so a cycle cannot loop.
- Traversal is breadth-first and sorted by name at each level, so a clash between two skills resolves the same way on every machine. The clash logs a warning naming both files; it is a packaging accident, not an override.
- `/agents` never writes to a skill's file. Eject copies the file verbatim to a user location; Disable writes a user stub that shadows it. Edit, Delete, and Reset are not offered.

Done check: `npx vitest run test/custom-agents.test.ts` passes.

## Consequences

- Ranking skill agents above user files would let installing a skill silently replace a user's agent.
- Editing skill files in place would fail on read-only stores and be lost on the next skill update.
- Revisit if project-scoped or package-provided skills need to ship agents; the scan root is the only change, but precedence for those relative to global user agents needs deciding.
