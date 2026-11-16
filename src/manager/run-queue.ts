import type { AgentRecord } from "../types.js";
import type { Pool } from "./agent-manager-rules.js";

export interface QueuedRun {
  id: string;
  pool: Pool;
  start: () => Promise<void>;
  release: () => void;
}

export function enqueueRun(queue: QueuedRun[], record: AgentRecord, pool: Pool, start: () => Promise<void>): number {
  let release!: () => void;
  record.startGate = new Promise<void>(resolve => { release = resolve; });
  queue.push({ id: record.id, pool, start, release: () => release() });
  return queue.filter(entry => entry.pool === pool).length - 1;
}
