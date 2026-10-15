> DRAFT: not accepted, not current truth.

# NNNN. Packages pi provides at runtime are peer dependencies only

## Context

pi's extension loader (`dist/core/extensions/loader.js` in `@earendil-works/pi-coding-agent`) maps `typebox`, `@sinclair/typebox`, their `/compile` and `/value` subpaths, and the `@earendil-works/pi-*` packages to pi's own bundled copies. pi's package docs (`docs/packages.md`, "Dependencies") say an extension that imports a bundled core package lists it in `peerDependencies` and does not bundle it. A copy installed under `dependencies` can bypass the loader's mapping and load a second runtime module, so schemas built with one copy are checked against the other.

pi installs git and local packages with `npm install`, so anything under `dependencies` is installed and can shadow pi's copy.

## Decision

Packages pi provides at runtime are never listed under `dependencies` in `package.json`. They are:

- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and any other `@earendil-works/pi-*` package this extension imports.
- `typebox` and `@sinclair/typebox`.

Rules:

- Each one this extension imports is in `peerDependencies`. `typebox` and `@sinclair/typebox` use `"*"`.
- The `@earendil-works/pi-*` peers use `>=1.0.0`. Versions before 1.0.0 are not tested, so the floor is the support statement; it deviates from the `"*"` pi's docs suggest on purpose.
- Pinned copies for typecheck and tests go in `devDependencies`.
- Third-party runtime packages pi does not provide, such as `croner` and `nanoid`, stay in `dependencies`.

Done check: `npm pkg get dependencies | grep -E 'typebox|@earendil-works/'` prints nothing.

## Consequences

- Moving a pi-provided package back to `dependencies` risks duplicate runtime modules. The failures show up as schema or `instanceof` mismatches at runtime, not at build.
- At runtime `@sinclair/typebox` resolves to pi's bundled `typebox`, while tests typecheck against the pinned `@sinclair/typebox` dev copy. Revisit the dev pins when pi changes what it bundles or the loader aliases.
- Raising the pi floor is a support decision. Change it together with the `@earendil-works/pi-*` dev pins.
