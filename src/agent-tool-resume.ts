// Resume an existing agent from the Agent tool, detached or blocking.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import type { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager-rules.js";
import type { StartBackgroundResume } from "./background-resume.js";
import { partialOutputSuffix } from "./status-note.js";
import { buildDetails, textResult } from "./tool-result.js";

export interface ResumeAgentDeps {
  manager: Pick<AgentManager, "getRecord" | "getMaxConcurrent" | "resume">;
  startBackgroundResume: StartBackgroundResume;
}

export interface ResumeAgentInput {
  ctx: ExtensionContext;
  toolCallId: string;
  params: { prompt: string; resume: string };
  signal: AbortSignal | undefined;
  call: Extract<AgentCallResolution, { ok: true }>;
}

/** Resume the agent named by `params.resume` and return the tool result. */
export async function resumeAgentCall(deps: ResumeAgentDeps, input: ResumeAgentInput) {
  const { manager, startBackgroundResume } = deps;
  const { ctx, toolCallId, params, signal, call } = input;
  const { runInBackground, outputTranscript, effectiveMaxTurns, detailBase } = call;

  const existing = manager.getRecord(params.resume);
  if (!existing || !isTopLevelAgent(existing)) {
    return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
  }
  if (!existing.session) {
    return textResult(`Agent "${params.resume}" has no active session to resume.`);
  }

  // Background resume: detached run that notifies on completion, mirroring
  // a background spawn. Previously run_in_background was silently ignored
  // on resume (this branch returned before the background branch below),
  // so a resumed agent always blocked the main loop until it finished.
  if (runInBackground) {
    const id = existing.id;
    // A detached resume hands control back while the record stays
    // "running", so nothing stops the model from resuming the same agent
    // again mid-run. manager.resume() refuses that (it would orphan the
    // live run's abort controller); say why here, where the model can act
    // on it, instead of letting it read as a generic failure.
    if (existing.status === "running" || existing.status === "queued") {
      return textResult(
        `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
        `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
      );
    }

    const record = await startBackgroundResume(ctx, existing, params.prompt, {
      outputTranscript,
      maxTurns: effectiveMaxTurns,
      toolCallId,
    });
    if (!record) {
      return textResult(`Failed to resume agent "${params.resume}".`);
    }

    const isQueued = record.status === "queued";
    return textResult(
      `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${existing.type}\n` +
      (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
      { ...detailBaseFor(detailBase, record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
    );
  }

  const record = await manager.resume(params.resume, params.prompt, signal);
  if (!record) {
    return textResult(`Failed to resume agent "${params.resume}".`);
  }
  // A failed resume surfaces the error, plus any partial output THIS
  // resume produced (never the previous turn's answer, #144).
  if (record.status === "error") {
    return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(detailBase, record), record));
  }
  return textResult(
    record.result?.trim() || "No output.",
    buildDetails(detailBaseFor(detailBase, record), record),
  );
}
