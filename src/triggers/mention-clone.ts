import type { Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  createAgentSession,
  type ExtensionContext,
  type ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "../session/child-context.js";
import { FORCED_BACKGROUND } from "../tool/invocation-config.js";
import type { SubagentType } from "../types.js";
import { agentMentionReminder } from "./mention.js";

export interface MentionCloneOptions {
  ctx: ExtensionContext;
  type: SubagentType;
  message: string;
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  spawned: boolean;
  error?: string;
  refusal?: string;
}

const REFUSED_PARAMS = ["max_turns", "run_in_background", "resume"] as const;

function refusalFor(params: Record<string, unknown>): string | undefined {
  const present = REFUSED_PARAMS.filter(name => params[name] !== undefined);
  if (present.length === 0) return undefined;
  return `Refused: an @mention run cannot set ${present.join(", ")}. Only model and thinking may be overridden here; call the agent tool again without ${present.length === 1 ? "it" : "them"}.`;
}

export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  let refusal: string | undefined;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, cloneCtx) => {
      const requested = (params as { subagent_type?: unknown }).subagent_type;
      if (typeof requested !== "string" || requested.trim().toLowerCase() !== type.toLowerCase()) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: `This mention starts the "${type}" agent. Call again with subagent_type "${type}".` }],
          details: undefined,
          isError: true,
        });
      }
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      const refused = refusalFor(params as Record<string, unknown>);
      if (refused) {
        refusal = refused;
        return Promise.resolve({
          content: [{ type: "text" as const, text: refused }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), [FORCED_BACKGROUND]: true } as typeof params,
        signal,
        onUpdate,
        Object.assign(Object.create(ctx), { tools: cloneCtx.tools, executeTool: cloneCtx.executeTool }),
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
    const conversation = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model: ctx.model as Model<never> | undefined,
        ...(ctx.thinkingLevel && { thinkingLevel: ctx.thinkingLevel }),
        modelRuntime: parentModelRuntime,
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      }),
    );
    session = created.session;

    const systemPrompt = ctx.getSystemPrompt?.();
    if (systemPrompt) session.agent.state.messages.push({ role: "system", content: systemPrompt, timestamp: Date.now() });

    session.agent.state.messages.push(...conversation.messages);

    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  if (spawned) return { spawned: true };
  if (refusal) return { spawned: false, refusal };
  return { spawned: false, error: "the conversation clone did not start it" };
}
