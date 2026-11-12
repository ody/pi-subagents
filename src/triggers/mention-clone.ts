import type { Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  createAgentSession,
  type ExtensionContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "../session/child-context.js";
import type { SubagentType, ThinkingLevel } from "../types.js";
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
}

export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, _cloneCtx) => {
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
      spawned = true;
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        ctx,
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
    const conversation = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    const thinkingLevel = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model: ctx.model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        modelRegistry: ctx.modelRegistry,
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]),
    );
    session = created.session;

    const systemPrompt = ctx.getSystemPrompt?.();
    if (systemPrompt) session.agent.state.systemPrompt = systemPrompt;

    session.agent.state.messages.push(...conversation.messages);

    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
