/**
 * agent-tree.ts — pure projection of the manager's records into a flat,
 * pre-order list of tree nodes.
 *
 * The manager already knows the whole hierarchy: `AgentRecord.parentAgentId`
 * links a nested child to its spawner and `AgentRecord.workflowId` links a
 * workflow-owned child to its run. Nothing rendered it — every agent surface
 * filtered through `isTopLevelAgent`, so a nested agent was unreachable. This
 * module turns those two fields into rows, and owns nothing else: no rendering,
 * no key handling, no manager access. Callers pass records in and get rows out.
 *
 * Flat-with-depth rather than a real tree component on purpose. The existing
 * list views already handle windowing, selection and repaint against an array;
 * a pre-order flatten adds hierarchy without replacing any of that.
 */

import type { AgentRecord } from "../types.js";

/** Stable key for `main`, the one node that has no backing record. */
export const MAIN_KEY = "main";

/** `workflow:<runId>` — the virtual container row for a workflow run. */
export function workflowKey(id: string): string {
  return `workflow:${id}`;
}

/** `agent:<recordId>` — a row backed by a manager record. */
export function agentKey(id: string): string {
  return `agent:${id}`;
}

/**
 * One row. `W` is the caller's own workflow shape (the fleet list has
 * `FleetWorkflow`, the `/agents` menu has its own) — this module only ever
 * reads `.id` off it.
 */
export type AgentTreeNode<W extends { id: string }> =
  | { kind: "main"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: false }
  | { kind: "workflow"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: false; workflow: W }
  | { kind: "agent"; key: string; depth: number; parentKey?: string; hasChildren: boolean; collapsed: boolean; orphan: boolean; record: AgentRecord };

export interface AgentTreeOptions<W extends { id: string }> {
  /**
   * Every record the manager knows about — NOT a pre-filtered list. Topology is
   * derived from the full set so a child whose parent is ineligible for display
   * still resolves to that parent rather than looking detached.
   */
  records: readonly AgentRecord[];
  /**
   * Workflow container rows, in the order the caller wants them. Already
   * filtered by the caller (the fleet list applies its own linger window).
   */
  workflows?: readonly W[];
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
 * chain is acyclic, else its `workflowId` when that run is in `workflows`. Any
 * other linkage — a parent evicted by GC, a workflow row the caller filtered
 * out, a cycle from a malformed caller — is promoted to a root and marked
 * `orphan`. Dropping those rows is what the old code effectively did, and it is
 * the bug: an unreachable agent cannot be stopped.
 */
export function buildAgentTree<W extends { id: string }>(options: AgentTreeOptions<W>): AgentTreeNode<W>[] {
  const { records, workflows = [], isEligible = () => true, collapsed, includeMain = true } = options;

  const byId = new Map<string, AgentRecord>();
  for (const record of records) byId.set(record.id, record);
  const workflowIds = new Set(workflows.map(w => w.id));

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
    } else if (record.workflowId !== undefined && !workflowIds.has(record.workflowId)) {
      // A live workflow child whose run row the caller left out: show it rather
      // than hide it, but say it is detached.
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
  const push = (key: string, record: AgentRecord) => {
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(record);
    else childrenOf.set(key, [record]);
  };
  for (const record of records) {
    if (!shown.has(record.id)) continue;
    const parentId = parentIdOf.get(record.id);
    if (parentId !== undefined) push(agentKey(parentId), record);
    else if (record.workflowId !== undefined && !orphans.has(record.id)) push(workflowKey(record.workflowId), record);
    else roots.push(record);
  }
  for (const bucket of childrenOf.values()) bucket.sort(bySiblingOrder);
  roots.sort(bySiblingOrder);

  const nodes: AgentTreeNode<W>[] = [];
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
  for (const workflow of workflows) {
    const key = workflowKey(workflow.id);
    const children = childrenOf.get(key) ?? [];
    const isCollapsed = collapsed?.has(key) === true;
    nodes.push({
      kind: "workflow",
      key,
      depth: 0,
      hasChildren: children.length > 0,
      collapsed: isCollapsed,
      orphan: false,
      workflow,
    });
    if (!isCollapsed) emitAgents(children, 1, key);
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
export function resolveSelectedKey<W extends { id: string }>(
  nodes: readonly AgentTreeNode<W>[],
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
export function ancestorKeys<W extends { id: string }>(
  nodes: readonly AgentTreeNode<W>[],
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
