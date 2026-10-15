// The `Agent` tool definition: parameter schema, rendering hooks, and the
// execute dispatch over schedule, resume, background and foreground spawns.

import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createActivityTracker } from "./activity-tracker.js";
import { detailBaseFor, resolveAgentCall } from "./agent-call-resolution.js";
import type { AgentManager } from "./agent-manager.js";
import { isTopLevelAgent } from "./agent-manager-rules.js";
import { buildAgentToolDescription } from "./agent-tool-description.js";
import { runForegroundAgent } from "./agent-tool-foreground.js";
import { renderAgentCall, renderAgentResult } from "./agent-tool-render.js";
import { getAvailableTypes } from "./agent-types.js";
import type { StartBackgroundResume } from "./background-resume.js";
import type { CompletionNotifier } from "./completion-notifier.js";
import { SUBAGENT_TOOL_NAMES } from "./extension-scope.js";
import { isolationParam, resolveJoinMode } from "./invocation-config.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import type { SubagentScheduler } from "./schedule.js";
import { partialOutputSuffix } from "./status-note.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import { buildDetails, textResult } from "./tool-result.js";
import type { AgentRecord } from "./types.js";
import type { AgentWidget, UICtx } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

export interface AgentToolDeps {
  manager: Pick<
    AgentManager,
    "getRecord" | "getMaxConcurrent" | "resume" | "spawn" | "awaitStartup" | "getActivity" | "listAgents" | "spawnAndWait"
  >;
  scheduler: Pick<SubagentScheduler, "isActive" | "addJob" | "getNextRun">;
  widget: Pick<AgentWidget, "setUICtx" | "ensureTimer" | "update" | "markFinished">;
  fleet: Pick<FleetList, "ensureTimer" | "update" | "onAgentFinished">;
  notifier: Pick<CompletionNotifier, "addToBatch">;
  startBackgroundResume: StartBackgroundResume;
  reloadCustomAgents: () => void;
  settings: Readonly<Pick<
    RuntimeSettings,
    "schedulingEnabled" | "toolDescriptionMode" | "backgroundByDefault" | "defaultJoinMode" | "showCost"
  >>;
}

/**
 * Define the Agent tool. Returns the bare tool; the caller wraps it for usage
 * reporting and registers it. The description mode and the scheduling switch
 * are read once, here, so call this after persisted settings are applied.
 */
export function createAgentTool(pi: ExtensionAPI, deps: AgentToolDeps) {
  const { manager, scheduler, widget, fleet, notifier, startBackgroundResume, reloadCustomAgents, settings } = deps;

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    settings.schedulingEnabled ? scheduleParamShape : {};

  const agentToolDescription = buildAgentToolDescription({
    mode: settings.toolDescriptionMode,
    schedulingEnabled: settings.schedulingEnabled,
    worktreeEnabled: isWorktreeIsolationEnabled(),
  });

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise handle it yourself when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Only set this when the user named a model in their request; otherwise omit.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall: renderAgentCall,

    // Read at render time so toggling the cost setting applies to existing rows.
    renderResult: (result, options, theme, renderContext) =>
      renderAgentResult(result, options, theme, renderContext, settings.showCost),

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const call = resolveAgentCall(params, ctx, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: settings.backgroundByDefault,
      });
      if (!call.ok) return textResult(call.message);
      const {
        subagentType,
        requestedType,
        fallbackNote,
        displayName,
        model,
        thinking,
        inheritContext,
        runInBackground,
        isolated,
        isolation,
        outputTranscript,
        effectiveMaxTurns,
        agentInvocation,
        detailBase,
      } = call;

      // `attachTranscript` is the SOLE gate for the .output transcript (whether
      // it is on comes from resolveAgentCall) — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!settings.schedulingEnabled) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return textResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
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

      // Resume existing agent
      if (params.resume) {
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

      // Background execution
      if (runInBackground) {
        const bgCallbacks = createActivityTracker();

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        // With isolation: "worktree" the agent isn't running yet — the repo
        // copy is an awaited git call. Wait for it here, after the synchronous
        // wiring above, so a strict-isolation failure still fails THIS tool
        // call instead of being reported as a subagent that ran (#179).
        await manager.awaitStartup(id);

        if (joinMode == null || joinMode === 'async') {
          // Foreground/no join mode or explicit async — not part of any batch
        } else {
          // smart or group — add to current batch
          notifier.addToBatch(id, joinMode);
        }

        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(detailBase, record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      return runForegroundAgent(
        { pi, manager, widget, fleet, settings },
        { ctx, params, signal, onUpdate, call, attachTranscript },
      );
    },
  });

  return agentTool;
}
