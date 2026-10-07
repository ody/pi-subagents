# 0001. Decision records and GitHub issue backlog

## Context

Rationale that does not fit in code comments or commit messages needs a home, or it is lost and the decision gets undone. Heavy per-change spec archives drift from the code and add inference cost without raising agent task success. Short, concrete constraints an agent can follow do help.

## Decision

Non-obvious rationale lives in Nygard-style decision records at `docs/decisions/NNNN-slug.md`, one decision per file, about one screen each. No status field: the directory holds only current truth.

- `docs/decisions/*.md` is current truth. An agent working in this repo must follow it.
- Every ADR has the sections `Context`, `Decision`, and `Consequences`, from `docs/decisions/0000-template.md`.
- `docs/decisions/drafts/` holds unnumbered drafts, hidden from recursive search by the root `.ignore` file. Ignore drafts unless asked to work on one. Every draft opens with `> DRAFT: not accepted, not current truth.`; acceptance removes the line.
- Accepting a draft is `git mv docs/decisions/drafts/<slug>.md docs/decisions/NNNN-<slug>.md`, assigning the number then. Abandoning a draft is deleting it.
- Numbers are never reused, so superseding or deleting leaves a gap in the sequence.
- To supersede: write the new ADR, moving anything still true into it, and delete the old one in the same commit. Record `Replaces: NNNN-old-slug, last present in <commit>` under the title, where `<commit>` is the last commit that still contains the old file (`HEAD` at writing time). Retrieve old text with `git show <commit>:docs/decisions/NNNN-old-slug.md`.
- Work for later goes to GitHub issues at `github.com/ody/pi-subagents`, driven with `gh` and the `gh` skill. Labels: `task`, `bug`, `chore`.

## Consequences

Reversing this means reintroducing a heavier process; the ADR directory would need a status convention or an archive location first. Revisit if the project gains more maintainers, since review load changes, or if spec archives are shown to help rather than drift.
