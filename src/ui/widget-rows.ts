import { isTopLevelAgent } from "../manager/agent-manager-rules.js";
import type { AgentRecord, WidgetMode } from "../types.js";

export interface WidgetRow {
  record: AgentRecord;
  depth: number;
}

export interface WidgetRows {
  finished: WidgetRow[];
  running: WidgetRow[];
  queued: AgentRecord[];
  runningTopLevel: number;
}

export interface CollectRowsOptions {
  records: readonly AgentRecord[];
  mode: WidgetMode;
  lingers: (record: AgentRecord) => boolean;
  held: ReadonlySet<string>;
}

const isSettled = (record: AgentRecord): boolean => record.status !== "running" && record.status !== "queued";

function selectTopLevel(records: readonly AgentRecord[], mode: WidgetMode): AgentRecord[] {
  const tops = records.filter(isTopLevelAgent);
  switch (mode) {
    case "off": return [];
    case "background": return tops.filter(record => record.isBackground !== false);
    default: return tops;
  }
}

function ancestryDepth(record: AgentRecord, byId: ReadonlyMap<string, AgentRecord>): number {
  const seen = new Set<string>([record.id]);
  let depth = 0;
  let cursor = record.parentAgentId;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    depth++;
    cursor = byId.get(cursor)?.parentAgentId;
  }
  return depth;
}

const byStart = (a: AgentRecord, b: AgentRecord): number => a.startedAt - b.startedAt;

function walkRunning(
  records: readonly AgentRecord[],
  roots: readonly AgentRecord[],
  held: ReadonlySet<string>,
  byId: ReadonlyMap<string, AgentRecord>,
): WidgetRow[] {
  const childrenOf = new Map<string, AgentRecord[]>();
  for (const record of records) {
    if (record.parentAgentId === undefined || record.status !== "running") continue;
    const bucket = childrenOf.get(record.parentAgentId);
    if (bucket) bucket.push(record);
    else childrenOf.set(record.parentAgentId, [record]);
  }
  for (const bucket of childrenOf.values()) bucket.sort(byStart);

  const rows: WidgetRow[] = [];
  const emitted = new Set<string>();
  const walk = (record: AgentRecord, depth: number): void => {
    if (emitted.has(record.id)) return;
    emitted.add(record.id);
    rows.push({ record, depth });
    for (const child of childrenOf.get(record.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const record of records) {
    if (held.has(record.id) && record.status === "running" && !emitted.has(record.id)) {
      walk(record, ancestryDepth(record, byId));
    }
  }
  return rows;
}

function orphanedRunning(records: readonly AgentRecord[], byId: ReadonlyMap<string, AgentRecord>): AgentRecord[] {
  return records
    .filter(record => record.status === "running" && record.parentAgentId !== undefined && !byId.has(record.parentAgentId))
    .sort(byStart);
}

function finishedRows(
  records: readonly AgentRecord[],
  tops: readonly AgentRecord[],
  options: CollectRowsOptions,
  byId: ReadonlyMap<string, AgentRecord>,
): WidgetRow[] {
  const { lingers, held } = options;
  const rows: WidgetRow[] = tops
    .filter(record => isSettled(record) && record.completedAt && (lingers(record) || held.has(record.id)))
    .map(record => ({ record, depth: 0 }));
  for (const record of records) {
    if (!isTopLevelAgent(record) && isSettled(record) && held.has(record.id)) {
      rows.push({ record, depth: ancestryDepth(record, byId) });
    }
  }
  return rows;
}

export function collectWidgetRows(options: CollectRowsOptions): WidgetRows {
  const { records, mode, held } = options;
  if (mode === "off") return { finished: [], running: [], queued: [], runningTopLevel: 0 };

  const byId = new Map(records.map(record => [record.id, record]));
  const tops = selectTopLevel(records, mode);
  const runningTops = tops.filter(record => record.status === "running");
  return {
    finished: finishedRows(records, tops, options, byId),
    running: walkRunning(records, [...runningTops, ...orphanedRunning(records, byId)], held, byId),
    queued: tops.filter(record => record.status === "queued"),
    runningTopLevel: runningTops.length,
  };
}

export function agentRowIds(rows: WidgetRows): string[] {
  return [...rows.finished, ...rows.running].map(row => row.record.id);
}
