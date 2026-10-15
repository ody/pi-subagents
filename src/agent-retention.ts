import { shutdownChildSession } from "./agent-session-shutdown.js";
import type { AgentRecord, AgentTombstone, MentionResolution } from "./types.js";

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

export interface RetentionDeps {
  agents: Map<string, AgentRecord>;
  activities: { delete(id: string): boolean };
  startups: Map<string, Promise<void>>;
  tombstones: Map<string, AgentTombstone>;
}

/** Handles already in use, so a fresh spawn can pick an unclaimed one. */
export function takenHandles(deps: RetentionDeps): Set<string> {
  const taken = new Set<string>();
  for (const record of deps.agents.values()) {
    if (record.handle) taken.add(record.handle);
    if (record.alias) taken.add(record.alias);
  }
  // Tombstones hold their names too: an evicted `@explore` is still
  // resurrectable, so a later Explore must become `explore-2` rather than
  // shadowing a conversation the user can still reach.
  for (const entry of deps.tombstones.values()) {
    taken.add(entry.handle);
    if (entry.alias) taken.add(entry.alias);
  }
  return taken;
}

/**
 * Resolve an `@name` from the prompt. Matches a top-level agent's handle
 * case-insensitively, preferring one that can still be steered and otherwise
 * the most recently started (which is the one a resume should continue), then
 * falls back to an exact agent id so `@<agentId>` works too.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the established resolution precedence without splitting a single lookup.
export function resolveMention(deps: RetentionDeps, name: string): MentionResolution | undefined {
  const wanted = name.toLowerCase();
  let fallback: AgentRecord | undefined;
  for (const record of deps.agents.values()) {
    if (record.parentAgentId !== undefined) continue;
    // Handle and alias share one namespace, so at most one agent answers a
    // name and it makes no difference which of the two matched.
    if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
    if (record.status === "running" || record.status === "queued") return { kind: "live", record };
    if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
  }
  if (fallback) return { kind: "live", record: fallback };
  const byId = deps.agents.get(name);
  if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
  // Only once nothing live answers: a tombstone is a conversation to reopen,
  // and reopening one while its record still exists would fork the session.
  for (const entry of deps.tombstones.values()) {
    if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
      return { kind: "tombstone", entry };
    }
  }
  return undefined;
}

/**
 * Forget an evicted agent, by handle. For the case where its session file has
 * gone: the entry can then only ever fail, while still holding the name
 * against the type that would otherwise start a fresh agent under it.
 *
 * A *successful* resume does not drop its tombstone — the live record it
 * creates already wins in `resolveMention`, and overwrites the entry in place
 * when it is itself evicted.
 */
export function dropTombstone(deps: RetentionDeps, handle: string): void {
  deps.tombstones.delete(handle);
}

/** Evicted agents whose conversation can still be reopened, newest first. */
export function listTombstones(deps: RetentionDeps): AgentTombstone[] {
  return [...deps.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
}

/** Dispose a record's session and remove it from the map. */
export function removeRecord(deps: RetentionDeps, id: string, record: AgentRecord): void {
  tombstone(deps, record);
  const session = record.session;
  // Detached before the shutdown starts, so the record leaves the map at once and
  // nothing can observe a session that is half torn down.
  record.session = undefined;
  deps.agents.delete(id);
  deps.activities.delete(id);
  // A failed startup keeps its (rejected) entry so a late awaitStartup still
  // sees it; drop it with the record so the map can't grow unbounded.
  deps.startups.delete(id);
  // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
  // and from `clearCompleted()` on session boundaries, with the process staying alive,
  // so handlers get their full window. The quit path awaits instead — see dispose().
  void shutdownChildSession(session);
}

/**
 * Preserve enough of a departing record for `@handle` to reopen its
 * conversation later. Nothing to keep unless it has both a handle to be
 * addressed by and a session file to reopen — an in-memory session leaves no
 * transcript, so the mention would have nothing to continue from.
 */
function tombstone(deps: RetentionDeps, record: AgentRecord): void {
  if (!record.handle || !record.sessionFile) return;
  deps.tombstones.set(record.handle, {
    handle: record.handle,
    alias: record.alias,
    id: record.id,
    type: record.type,
    description: record.description,
    sessionFile: record.sessionFile,
    completedAt: record.completedAt ?? Date.now(),
  });
  // Bound the memory a long session can accumulate. Oldest first, since the
  // agent someone still wants to reach is the one they used most recently.
  while (deps.tombstones.size > MAX_TOMBSTONES) {
    const oldest = [...deps.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
    deps.tombstones.delete(oldest.handle);
  }
}

export function cleanup(deps: RetentionDeps): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, record] of deps.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if ((record.completedAt ?? 0) >= cutoff) continue;
    removeRecord(deps, id, record);
  }
}

/**
 * Remove all completed/stopped/errored records immediately.
 * Called on session start/switch so tasks from a prior session don't persist.
 * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
 * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
 */
export function clearCompleted(deps: RetentionDeps, skipUnconsumed = false): void {
  for (const [id, record] of deps.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if (skipUnconsumed && !record.resultConsumed) continue;
    removeRecord(deps, id, record);
  }
  // Unconditional: both callers are session boundaries (`session_start` and
  // `session_before_switch`), and `skipUnconsumed` only spares records whose
  // results the LLM has yet to read — it does not make the sweep partial in
  // the sense that matters here. A new session means new handles, or
  // `@explore` would silently reach an agent the user never started. Claude
  // Code resets its registry on `/clear` for the same reason.
  deps.tombstones.clear();
}
