import type { AgentRecord } from "../types.js";

export function getStatusNote(status: string, stoppedBy: "user" | "agent" = "user"): string {
  switch (status) {
    case "stopped":
      return stoppedBy === "agent"
        ? " (STOPPED BY THE ORCHESTRATING AGENT before completion — output is partial; the task was NOT finished)"
        : " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

export function getForegroundOutcomeNote(status: string, stoppedBy: "user" | "agent" = "user"): string {
  switch (status) {
    case "stopped":
      return stoppedBy === "agent"
        ? " (STOPPED BY THE ORCHESTRATING AGENT — everything the agent produced is above; the task is unfinished)"
        : " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
