import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractText } from "./context.js";

export function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

export function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

export function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    switch (msg.role) {
      case "user":
        parts.push(...formatUserMessage(msg));
        break;
      case "assistant":
        parts.push(...formatAssistantMessage(msg));
        break;
      case "toolResult":
        parts.push(formatToolResult(msg));
        break;
    }
  }

  return parts.join("\n\n");
}

type SessionMessage = AgentSession["messages"][number];

function formatUserMessage(msg: Extract<SessionMessage, { role: "user" }>): string[] {
  const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
  return text.trim() ? [`[User]: ${text.trim()}`] : [];
}

function formatAssistantMessage(msg: Extract<SessionMessage, { role: "assistant" }>): string[] {
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  for (const c of msg.content) {
    if (c.type === "text" && c.text) textParts.push(c.text);
    else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
  }
  const parts: string[] = [];
  if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
  if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
  return parts;
}

function formatToolResult(msg: Extract<SessionMessage, { role: "toolResult" }>): string {
  const text = extractText(msg.content);
  const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
  return `[Tool Result (${msg.toolName})]: ${truncated}`;
}
