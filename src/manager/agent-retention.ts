import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shutdownChildSession } from "../session/agent-session-shutdown.js";
import type { AgentRecord, AgentTombstone, MentionResolution } from "../types.js";

const MAX_TOMBSTONES = 100;

export interface RetentionDeps {
  agents: Map<string, AgentRecord>;
  activities: { delete(id: string): boolean };
  startups: Map<string, Promise<void>>;
  tombstones: Map<string, AgentTombstone>;
  isNotificationPending?: (id: string) => boolean;
}

export function rebuildTombstones(deps: RetentionDeps, branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): void {
  deps.tombstones.clear();
  const entries = branch.flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "agent:record" || !entry.data || typeof entry.data !== "object") return [];
    const data = entry.data as Partial<AgentTombstone>;
    if (!data.handle || !data.sessionFile || !data.id) return [];
    return [{ ...data, completedAt: typeof data.completedAt === "number" ? data.completedAt : 0 } as AgentTombstone];
  }).sort((a, b) => b.completedAt - a.completedAt);
  const ids = new Set<string>();
  const handles = new Set<string>();
  const liveHandles = new Set([...deps.agents.values()].map(record => record.handle?.toLowerCase()));
  for (const entry of entries) {
    const normalizedHandle = entry.handle.toLowerCase();
    if (ids.has(entry.id) || handles.has(normalizedHandle) || liveHandles.has(normalizedHandle) || deps.agents.has(entry.id)) continue;
    ids.add(entry.id);
    handles.add(normalizedHandle);
    const { handle, alias, id, type, description, sessionFile, completedAt, status, result, error, stopCause, agentConfig } = entry;
    deps.tombstones.set(handle, { handle, alias, id, type, description, sessionFile, completedAt, status, result, error, stopCause, agentConfig });
    if (deps.tombstones.size === MAX_TOMBSTONES) break;
  }
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
    if (deps.agents.has(entry.id)) continue;
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
  return [...deps.tombstones.values()].filter(entry => !deps.agents.has(entry.id)).sort((a, b) => b.completedAt - a.completedAt);
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
    status: record.status,
    result: record.result,
    error: record.error,
    stopCause: record.stopCause,
    agentConfig: record.agentConfig,
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
    if (deps.isNotificationPending?.(id)) continue;
    record.resultConsumed = true;
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
