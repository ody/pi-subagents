import type { AgentRecord } from "../types.js";

export interface RunOutcome {
  text: string;
  aborted?: boolean;
  steered?: boolean;
  failure?: string;
}

function terminalStatus({ aborted, steered, failure }: RunOutcome): AgentRecord["status"] {
  if (aborted) return "aborted";
  if (failure) return "error";
  return steered ? "steered" : "completed";
}

export function recordRunOutcome(record: AgentRecord, outcome: RunOutcome): void {
  if (record.status !== "stopped") {
    record.status = terminalStatus(outcome);
    if (outcome.failure && !outcome.aborted) record.error = outcome.failure;
  }
  record.result = outcome.text;
  record.completedAt ??= Date.now();
}

export function recordRunError(record: AgentRecord, err: unknown): void {
  if (record.status !== "stopped") record.status = "error";
  record.error = err instanceof Error ? err.message : String(err);
  record.completedAt ??= Date.now();
}
