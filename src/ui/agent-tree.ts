/**
 * agent-tree.ts — pure projection of the manager's records into a flat,
 * pre-order list of tree nodes.
 *
 * The manager already knows the whole hierarchy: `AgentRecord.parentAgentId`
 * links a nested child to its spawner. Nothing rendered it — every agent
 * surface filtered through `isTopLevelAgent`, so a nested agent was
 * unreachable. This module turns that field into rows, and owns nothing else:
 * no rendering, no key handling, no manager access. Callers pass records in
 * and get rows out.
 *
 * Flat-with-depth rather than a real tree component on purpose. The existing
 * list views already handle windowing, selection and repaint against an array;
 * a pre-order flatten adds hierarchy without replacing any of that.
 */

import type { AgentRecord } from "../types.js";

/** Stable key for `main`, the one node that has no backing record. */
export const MAIN_KEY = "main";

/** `agent:<recordId>` — a row backed by a manager record. */
export function agentKey(id: string): string {
  return `agent:${id}`;
}

/** One row. */
export type AgentTreeNode =
  | { kind: "main"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: false }
  | { kind: "agent"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: boolean; record: AgentRecord };

export interface AgentTreeOptions {
  /**
   * Every record the manager knows about — NOT a pre-filtered list. Topology is
   * derived from the full set so a child whose parent is ineligible for display
   * still resolves to that parent rather than looking detached.
   */
  records: readonly AgentRecord[];
  /**
   * Which records the caller wants shown. A record that fails this test is
   * still emitted when a descendant passes it — an active grandchild must never
   * disappear because its parent aged out of a display window. Default: all.
   */
  isEligible?: (record: AgentRecord) => boolean;
  /** Keys whose children are hidden. The node itself still renders. */
  collapsed?: ReadonlySet<string>;
  /** Emit the `main` row first. Default true. */
  includeMain?: boolean;
}

/** Deterministic sibling order: oldest first, id as the tie-break. */
function bySiblingOrder(a: AgentRecord, b: AgentRecord): number {
  return a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Flatten the hierarchy in pre-order.
 *
 * A record's parent is its `parentAgentId` when that record exists and the
 * chain is acyclic. Any other linkage — a parent evicted by GC, a cycle from a
 * malformed caller — is promoted to a root and marked `orphan`. Dropping those
 * rows is what the old code effectively did, and it is the bug: an unreachable
 * agent cannot be stopped.
 */
export function buildAgentTree(options: AgentTreeOptions): AgentTreeNode[] {
  const { records, isEligible = () => true, collapsed, includeMain = true } = options;

  const byId = new Map<string, AgentRecord>();
  for (const record of records) byId.set(record.id, record);

  /** Walks up `parentAgentId` to prove the chain terminates. */
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

  // Eligibility spreads upward: keep every ancestor of a shown record.
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

/**
 * Pick the row to select after the tree changed.
 *
 * Index-based selection breaks the moment a child starts or settles mid-run, so
 * every caller holds a key and re-resolves it here: the same key when it is
 * still visible, else its nearest visible ancestor (the usual case — an
 * ancestor was just collapsed), else the row before where it used to be, else
 * the first row.
 */
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

/** Ancestor keys of `key`, nearest first — the fallback chain for the above. */
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
