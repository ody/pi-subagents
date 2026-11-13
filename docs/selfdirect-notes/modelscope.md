# modelscope notes

Tickets: #82, #89, #90 (ADR 0024).

## Decisions

- `checkModelScope` returns `replace` (with `replaced`) instead of `warn`. `scopeModel` in `src/config/model-scope.ts` wraps it and returns the model to run. All sites share it.
- Both `agent` tools check only a pin that resolved. An absent or unresolved pin leaves the session model unchecked.
- `resolveNestedModel` now returns `{ pinned }`, not `{ model }`, and lost its session-model parameter.
- The nested tool now notifies through `ctx.ui?.notify`. ADR 0024 says "notifies the user at every site", which overrides the old README line that nested spawns have no UI.
- The funnel passes `options.model` only after a replacement or for a caller-supplied model. An in-scope file pin stays with `resolveDefaultModel` in the runner, so its availability fallback still applies.
- A caller-supplied `options.model` reaching the funnel (RPC, registry) counts as caller-supplied. A string is resolved first. The RPC handler keeps its own check, because its unit tests use a mock manager.
- The funnel records the replacement as `modelReplaced` on `SpawnOptions` and `AgentRecord`, like `filtered`. The RPC reply reads it from the record. `spawnTopLevel` deletes a caller-supplied `modelReplaced`.
- The README had no spawn-path list, so #89 adds one to the Model Scope section.

## Unresolved

- If the session model is undefined and a pin is replaced, `options.model` is undefined and the runner falls back to the pin. The case needs a session without a model, which pi does not normally allow.
- `npm run check` reports pre-existing biome complexity infos. They do not fail the check.
