import type { AgentRecord, StopCause } from "../types.js";

const STOPPED_NOTES: Record<StopCause, string> = {
  user: " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished; the user chose to stop it, so do not restart it unless the user asks)",
  agent: " (STOPPED BY THE ORCHESTRATING AGENT before completion — output is partial; the task was NOT finished)",
  extension: " (STOPPED BY ANOTHER EXTENSION before completion — output is partial; the task was NOT finished; the user did not stop it)",
  owner: " (STOPPED BY ITS OWNING AGENT before completion — output is partial; the task was NOT finished; the owner finished or its call was interrupted)",
  shutdown: " (STOPPED BY THE SESSION SHUTTING DOWN before completion — output is partial; the task was NOT finished)",
};

const STOPPED_OUTCOME_NOTES: Record<StopCause, string> = {
  user: " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished; the user chose to stop it, so do not restart it unless the user asks)",
  agent: " (STOPPED BY THE ORCHESTRATING AGENT — everything the agent produced is above; the task is unfinished)",
  extension: " (STOPPED BY ANOTHER EXTENSION — everything the agent produced is above; the task is unfinished; the user did not stop it)",
  owner: " (STOPPED BY ITS OWNING AGENT — everything the agent produced is above; the task is unfinished; the owner finished or its call was interrupted)",
  shutdown: " (STOPPED BY THE SESSION SHUTTING DOWN — everything the agent produced is above; the task is unfinished)",
};

export function getStatusNote(status: string, stopCause: StopCause | undefined): string {
  switch (status) {
    case "stopped":
      return stopCause
        ? STOPPED_NOTES[stopCause]
        : " (STOPPED before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

export function getForegroundOutcomeNote(status: string, stopCause: StopCause | undefined): string {
  switch (status) {
    case "stopped":
      return stopCause
        ? STOPPED_OUTCOME_NOTES[stopCause]
        : " (STOPPED — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

export function partialOutputSuffix(record: Pick<AgentRecord, "result">): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
