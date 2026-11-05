import { shutdownChildSession } from "../session/agent-session-shutdown.js";
import type { AgentRecord, AgentTombstone, MentionResolution } from "../types.js";

const MAX_TOMBSTONES = 100;

export interface RetentionDeps {
  agents: Map<string, AgentRecord>;
  activities: { delete(id: string): boolean };
  startups: Map<string, Promise<void>>;
  tombstones: Map<string, AgentTombstone>;
}

export function takenHandles(deps: RetentionDeps): Set<string> {
  const taken = new Set<string>();
  for (const record of deps.agents.values()) {
    if (record.handle) taken.add(record.handle);
    if (record.alias) taken.add(record.alias);
  }
  for (const entry of deps.tombstones.values()) {
    taken.add(entry.handle);
    if (entry.alias) taken.add(entry.alias);
  }
  return taken;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the established resolution precedence without splitting a single lookup.
export function resolveMention(deps: RetentionDeps, name: string): MentionResolution | undefined {
  const wanted = name.toLowerCase();
  let fallback: AgentRecord | undefined;
  for (const record of deps.agents.values()) {
    if (record.parentAgentId !== undefined) continue;
    if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
    if (record.status === "running" || record.status === "queued") return { kind: "live", record };
    if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
  }
  if (fallback) return { kind: "live", record: fallback };
  const byId = deps.agents.get(name);
  if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
  for (const entry of deps.tombstones.values()) {
    if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
      return { kind: "tombstone", entry };
    }
  }
  return undefined;
}

export function dropTombstone(deps: RetentionDeps, handle: string): void {
  deps.tombstones.delete(handle);
}

export function listTombstones(deps: RetentionDeps): AgentTombstone[] {
  return [...deps.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
}

export function removeRecord(deps: RetentionDeps, id: string, record: AgentRecord): void {
  tombstone(deps, record);
  const session = record.session;
  record.session = undefined;
  deps.agents.delete(id);
  deps.activities.delete(id);
  deps.startups.delete(id);
  void shutdownChildSession(session);
}

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

export function clearCompleted(deps: RetentionDeps, skipUnconsumed = false): void {
  for (const [id, record] of deps.agents) {
    if (record.status === "running" || record.status === "queued") continue;
    if (skipUnconsumed && !record.resultConsumed) continue;
    removeRecord(deps, id, record);
  }
  deps.tombstones.clear();
}
