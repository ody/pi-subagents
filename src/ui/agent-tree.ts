import type { AgentRecord } from "../types.js";

export interface AgentTreeNode {
  depth: number;
  orphan: boolean;
  record: AgentRecord;
}

function bySiblingOrder(a: AgentRecord, b: AgentRecord): number {
  return a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function buildAgentTree(records: readonly AgentRecord[]): AgentTreeNode[] {
  const byId = new Map<string, AgentRecord>();
  for (const record of records) byId.set(record.id, record);

  const hasCycle = (record: AgentRecord): boolean => {
    const seen = new Set<string>([record.id]);
    let cursor = record.parentAgentId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentAgentId;
    }
    return false;
  };

  const orphans = new Set<string>();
  const childrenOf = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];
  for (const record of records) {
    const parentId = record.parentAgentId;
    if (parentId !== undefined && byId.has(parentId) && !hasCycle(record)) {
      const bucket = childrenOf.get(parentId);
      if (bucket) bucket.push(record);
      else childrenOf.set(parentId, [record]);
      continue;
    }
    if (parentId !== undefined) orphans.add(record.id);
    roots.push(record);
  }
  for (const bucket of childrenOf.values()) bucket.sort(bySiblingOrder);
  roots.sort(bySiblingOrder);

  const nodes: AgentTreeNode[] = [];
  const emit = (bucket: readonly AgentRecord[], depth: number): void => {
    for (const record of bucket) {
      nodes.push({ depth, orphan: orphans.has(record.id), record });
      emit(childrenOf.get(record.id) ?? [], depth + 1);
    }
  };
  emit(roots, 0);

  return nodes;
}
