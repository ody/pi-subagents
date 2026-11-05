import type { AgentRecord } from "../types.js";

export const MAIN_KEY = "main";

export function agentKey(id: string): string {
  return `agent:${id}`;
}

export type AgentTreeNode =
  | { kind: "main"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: false }
  | { kind: "agent"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: boolean; record: AgentRecord };

export interface AgentTreeOptions {
  records: readonly AgentRecord[];
  isEligible?: (record: AgentRecord) => boolean;
  collapsed?: ReadonlySet<string>;
  includeMain?: boolean;
}

function bySiblingOrder(a: AgentRecord, b: AgentRecord): number {
  return a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function buildAgentTree(options: AgentTreeOptions): AgentTreeNode[] {
  const { records, isEligible = () => true, collapsed, includeMain = true } = options;

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

  const parentIdOf = new Map<string, string | undefined>();
  const orphans = new Set<string>();
  for (const record of records) {
    if (record.parentAgentId !== undefined) {
      if (byId.has(record.parentAgentId) && !hasCycle(record)) {
        parentIdOf.set(record.id, record.parentAgentId);
        continue;
      }
      orphans.add(record.id);
    }
    parentIdOf.set(record.id, undefined);
  }

  const shown = new Set<string>();
  for (const record of records) {
    if (!isEligible(record)) continue;
    let cursor: AgentRecord | undefined = record;
    while (cursor !== undefined && !shown.has(cursor.id)) {
      shown.add(cursor.id);
      const parentId = parentIdOf.get(cursor.id);
      cursor = parentId === undefined ? undefined : byId.get(parentId);
    }
  }

  const childrenOf = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];
  for (const record of records) {
    if (!shown.has(record.id)) continue;
    const parentId = parentIdOf.get(record.id);
    if (parentId === undefined) {
      roots.push(record);
      continue;
    }
    const key = agentKey(parentId);
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(record);
    else childrenOf.set(key, [record]);
  }
  for (const bucket of childrenOf.values()) bucket.sort(bySiblingOrder);
  roots.sort(bySiblingOrder);

  const nodes: AgentTreeNode[] = [];
  const emitAgents = (bucket: readonly AgentRecord[], depth: number, parentKey: string | undefined): void => {
    for (const record of bucket) {
      const key = agentKey(record.id);
      const children = childrenOf.get(key) ?? [];
      const isCollapsed = collapsed?.has(key) === true;
      nodes.push({
        kind: "agent",
        key,
        depth,
        parentKey,
        hasChildren: children.length > 0,
        collapsed: isCollapsed,
        orphan: orphans.has(record.id),
        record,
      });
      if (!isCollapsed) emitAgents(children, depth + 1, key);
    }
  };

  if (includeMain) {
    nodes.push({ kind: "main", key: MAIN_KEY, depth: 0, hasChildren: false, collapsed: false, orphan: false });
  }
  emitAgents(roots, 0, undefined);

  return nodes;
}

export function resolveSelectedKey(
  nodes: readonly AgentTreeNode[],
  previousKey: string | undefined,
  previousAncestorKeys: readonly string[] = [],
): string | undefined {
  if (nodes.length === 0) return undefined;
  const visible = new Set(nodes.map(n => n.key));
  if (previousKey !== undefined && visible.has(previousKey)) return previousKey;
  for (const ancestor of previousAncestorKeys) {
    if (visible.has(ancestor)) return ancestor;
  }
  return nodes[0]?.key;
}

export function ancestorKeys(
  nodes: readonly AgentTreeNode[],
  key: string,
): string[] {
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const chain: string[] = [];
  let cursor = byKey.get(key)?.parentKey;
  while (cursor !== undefined && !chain.includes(cursor)) {
    chain.push(cursor);
    cursor = byKey.get(cursor)?.parentKey;
  }
  return chain;
}
