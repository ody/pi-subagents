import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../manager/agent-manager.js";
import { isTopLevelAgent } from "../manager/agent-manager-rules.js";
import type { StartBackgroundResume } from "../manager/background-resume.js";
import { type AgentCallResolution, detailBaseFor } from "./agent-call-resolution.js";
import { backgroundRunFooter } from "./agent-tool-background.js";
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

  if (runInBackground) {
    const id = existing.id;
    if (existing.status === "running" || existing.status === "queued") {
      return textResult(
        `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
        `Use agent_steer to send it a message mid-run, or agent_get_result to wait for it.`,
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

    return textResult(
      `Agent ${record.status === "queued" ? "queued" : "resumed"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${existing.type}\n` +
      backgroundRunFooter(record, manager.getMaxConcurrent()),
      { ...detailBaseFor(detailBase, record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
    );
  }

  const record = await manager.resume(params.resume, params.prompt, signal, { signalCause: "user" });
  if (!record) {
    return textResult(`Failed to resume agent "${params.resume}".`);
  }
  if (record.status === "error") {
    return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(detailBase, record), record));
  }
  return textResult(
    record.result?.trim() || "No output.",
    buildDetails(detailBaseFor(detailBase, record), record),
  );
}
