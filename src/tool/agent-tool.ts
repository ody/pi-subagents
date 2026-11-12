import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getAvailableTypes } from "../agents/agent-types.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import { THINKING_LEVELS } from "../config/thinking-levels.js";
import type { AgentManager } from "../manager/agent-manager.js";
import type { StartBackgroundResume } from "../manager/background-resume.js";
import type { CompletionNotifier } from "../manager/completion-notifier.js";
import { createOutputFilePath, writeInitialEntry } from "../platform/output-file.js";
import { isWorktreeIsolationEnabled } from "../platform/worktree.js";
import { SUBAGENT_TOOL_NAMES } from "../session/extension-scope.js";
import type { SubagentScheduler } from "../triggers/schedule.js";
import type { AgentRecord } from "../types.js";
import type { AgentWidget, UICtx } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { resolveAgentCall } from "./agent-call-resolution.js";
import { startBackgroundAgent } from "./agent-tool-background.js";
import { buildAgentToolDescription } from "./agent-tool-description.js";
import { runForegroundAgent } from "./agent-tool-foreground.js";
import { renderAgentCall, renderAgentResult } from "./agent-tool-render.js";
import { resumeAgentCall } from "./agent-tool-resume.js";
import { scheduleAgentCall } from "./agent-tool-schedule.js";
import { isolationParam } from "./invocation-config.js";
import { textResult } from "./tool-result.js";

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

export function createAgentTool(pi: ExtensionAPI, deps: AgentToolDeps) {
  const { manager, scheduler, widget, fleet, notifier, startBackgroundResume, reloadCustomAgents, settings } = deps;

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

  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn agent with an appropriate subagent_type (e.g. Explore). Otherwise handle it yourself when the target is already known.",
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
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides the agent's default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. 0 means unlimited. Overrides the agent's default.",
          minimum: 0,
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

    renderCall: renderAgentCall,

    renderResult: (result, options, theme, renderContext) =>
      renderAgentResult(result, options, theme, renderContext, settings.showCost),

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as UICtx);

      reloadCustomAgents();

      const resumed = params.resume ? manager.getRecord(params.resume)?.invocation : undefined;
      const callParams = params.resume
        ? {
          ...params,
          model: undefined,
          thinking: undefined,
          run_in_background: params.run_in_background ?? resumed?.runInBackground,
          max_turns: params.max_turns ?? resumed?.maxTurns,
        }
        : params;
      const call = resolveAgentCall(callParams, ctx, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: settings.backgroundByDefault,
      });
      if (!call.ok) return textResult(call.message);
      const { runInBackground, outputTranscript } = call;

      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      if (params.schedule) return scheduleAgentCall({ scheduler, settings }, { params, call });

      if (params.resume) {
        return resumeAgentCall(
          { manager, startBackgroundResume },
          { ctx, toolCallId, params: { prompt: params.prompt, resume: params.resume }, signal, call },
        );
      }

      if (runInBackground) {
        return startBackgroundAgent(
          { pi, manager, widget, fleet, notifier, settings },
          { ctx, toolCallId, params, call, attachTranscript },
        );
      }

      return runForegroundAgent(
        { pi, manager, widget, fleet, settings },
        { ctx, params, signal, onUpdate, call, attachTranscript },
      );
    },
  });

  return agentTool;
}
