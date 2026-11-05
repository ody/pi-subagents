// Scheduled Agent calls: validate the combination of parameters and register a
// job with the scheduler instead of spawning now.

import type { SubagentScheduler } from "../triggers/schedule.js";
import type { AgentCallResolution } from "./agent-call-resolution.js";
import { textResult } from "./tool-result.js";

export interface ScheduleAgentDeps {
  scheduler: Pick<SubagentScheduler, "isActive" | "addJob" | "getNextRun">;
  settings: Readonly<{ schedulingEnabled: boolean }>;
}

export interface ScheduleAgentInput {
  params: {
    prompt: string;
    description: string;
    schedule?: unknown;
    model?: string;
    resume?: string;
    inherit_context?: boolean;
    run_in_background?: boolean;
  };
  call: Extract<AgentCallResolution, { ok: true }>;
}

/**
 * The refusal text for a `schedule` call that cannot be honoured, or undefined.
 * Checks run in a fixed order, so a call with several conflicts always reports
 * the same one.
 */
export function scheduleConflict(
  params: Pick<ScheduleAgentInput["params"], "resume" | "inherit_context" | "run_in_background">,
  state: { schedulingEnabled: boolean; schedulerActive: boolean },
): string | undefined {
  if (!state.schedulingEnabled) {
    return "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.";
  }
  if (params.resume) {
    return "Cannot combine `schedule` with `resume` — schedules create fresh agents.";
  }
  if (params.inherit_context) {
    return "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.";
  }
  if (params.run_in_background === false) {
    return "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.";
  }
  if (!state.schedulerActive) {
    return "Scheduler is not active in this session yet. Try again after the session has fully started.";
  }
  return undefined;
}

/** Register a scheduled job for one Agent call and return its tool result. */
export function scheduleAgentCall(deps: ScheduleAgentDeps, input: ScheduleAgentInput) {
  const { scheduler, settings } = deps;
  const { params, call } = input;
  const { requestedType, fallbackNote, thinking, effectiveMaxTurns, isolated, isolation } = call;

  const conflict = scheduleConflict(params, {
    schedulingEnabled: settings.schedulingEnabled,
    schedulerActive: scheduler.isActive(),
  });
  if (conflict) return textResult(conflict);

  try {
    const job = scheduler.addJob({
      name: params.description,
      description: params.description,
      schedule: params.schedule as string,
      // The caller's own name, not the substitute — the scheduler re-resolves
      // at fire time, and the original is what a user edits.
      subagent_type: requestedType,
      prompt: params.prompt,
      model: params.model,
      thinking,
      max_turns: effectiveMaxTurns,
      isolated,
      isolation,
    });
    const next = scheduler.getNextRun(job.id);
    return textResult(
      `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
      `Next run: ${next ?? "(unknown)"}. ` +
      `Manage via /agents → Scheduled jobs.`,
    );
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }
}
