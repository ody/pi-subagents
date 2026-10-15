import { describe, expect, it } from "vitest";
import { collectResponseText, finalTurnError, getAgentConversation, getLastAssistantText } from "../src/session-text.js";

function fakeSession(messages: unknown[]) {
  return { messages } as never;
}

// collectResponseText keeps only the LAST assistant message's streamed text:
// a non-assistant message_start must not wipe what was already collected.
describe("collectResponseText", () => {
  function eventSession() {
    const listeners: Array<(event: unknown) => void> = [];
    let unsubscribed = false;
    const session = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {
          unsubscribed = true;
        };
      },
    };
    const emit = (event: unknown) => {
      for (const l of listeners) l(event);
    };
    return { session: session as never, emit, isUnsubscribed: () => unsubscribed };
  }
  const delta = (text: string) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  });

  it("accumulates text deltas and resets on each new assistant message", () => {
    const { session, emit } = eventSession();
    const collector = collectResponseText(session);
    emit({ type: "message_start", message: { role: "assistant" } });
    emit(delta("first"));
    emit({ type: "message_start", message: { role: "assistant" } });
    emit(delta("sec"));
    emit(delta("ond"));
    expect(collector.getText()).toBe("second");
  });

  it("does not reset on a user or toolResult message_start", () => {
    const { session, emit } = eventSession();
    const collector = collectResponseText(session);
    emit({ type: "message_start", message: { role: "assistant" } });
    emit(delta("kept"));
    emit({ type: "message_start", message: { role: "toolResult" } });
    emit({ type: "message_start", message: { role: "user" } });
    expect(collector.getText()).toBe("kept");
  });

  it("returns the session's unsubscribe", () => {
    const { session, isUnsubscribed } = eventSession();
    collectResponseText(session).unsubscribe();
    expect(isUnsubscribed()).toBe(true);
  });
});

describe("getLastAssistantText", () => {
  it("returns the last non-empty assistant text, trimmed", () => {
    const session = fakeSession([
      { role: "assistant", content: [{ type: "text", text: "older" }] },
      { role: "assistant", content: [{ type: "text", text: "  newest  " }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "user", content: "follow-up" },
    ]);
    expect(getLastAssistantText(session)).toBe("newest");
  });

  it("never walks back past startIndex (#144)", () => {
    const session = fakeSession([
      { role: "assistant", content: [{ type: "text", text: "prior turn" }] },
      { role: "user", content: "resume" },
      { role: "assistant", content: [] },
    ]);
    expect(getLastAssistantText(session, 1)).toBe("");
  });
});

describe("finalTurnError", () => {
  it("returns the provider error message of a final 'error' stop", () => {
    const session = fakeSession([
      { role: "assistant", stopReason: "error", errorMessage: " rate limited ", content: [] },
    ]);
    expect(finalTurnError(session)).toBe("rate limited");
  });

  it("falls back to a generic message when an error stop has no message", () => {
    const session = fakeSession([{ role: "assistant", stopReason: "error", content: [] }]);
    expect(finalTurnError(session)).toBe("provider error with no output");
  });

  it("reports a 'length' stop that produced no text", () => {
    const session = fakeSession([{ role: "assistant", stopReason: "length", content: [] }]);
    expect(finalTurnError(session)).toBe("run hit the output token limit before producing any text");
  });

  it("accepts a 'length' stop that produced text", () => {
    const session = fakeSession([
      { role: "assistant", stopReason: "length", content: [{ type: "text", text: "truncated" }] },
    ]);
    expect(finalTurnError(session)).toBeUndefined();
  });

  it("judges only the final assistant message", () => {
    const session = fakeSession([
      { role: "assistant", stopReason: "error", content: [] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(finalTurnError(session)).toBeUndefined();
  });

  it("ignores a failure before startIndex", () => {
    const session = fakeSession([
      { role: "assistant", stopReason: "error", content: [] },
      { role: "user", content: "resume" },
    ]);
    expect(finalTurnError(session, 1)).toBeUndefined();
  });
});

// getAgentConversation renders the subagent transcript shown in the /agents
// inspect overlay. Pure function over session.messages - no mocks needed
// beyond a literal-object session.
describe("getAgentConversation", () => {
  it("returns an empty string for a session with no messages", () => {
    expect(getAgentConversation(fakeSession([]))).toBe("");
  });

  it("formats a user-then-assistant exchange with role-prefixed lines joined by blank lines", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    expect(out).toBe("[User]: hi\n\n[Assistant]: hello");
  });

  it("accepts user content as content-blocks (not just strings)", () => {
    const out = getAgentConversation(
      fakeSession([{ role: "user", content: [{ type: "text", text: "from blocks" }] }]),
    );
    expect(out).toBe("[User]: from blocks");
  });

  it("emits a [Tool Calls] block listing each toolCall by name or toolName, falling back to 'unknown'", () => {
    const out = getAgentConversation(
      fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "toolCall", name: "search" },
            { type: "toolCall", toolName: "edit" },
            { type: "toolCall" },
          ],
        },
      ]),
    );
    expect(out).toContain("[Assistant]: calling tools");
    expect(out).toContain("[Tool Calls]:\n  Tool: search\n  Tool: edit\n  Tool: unknown");
  });

  it("truncates toolResult content beyond 200 chars and tags it with the tool name", () => {
    const longText = "x".repeat(300);
    const out = getAgentConversation(
      fakeSession([
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: longText }],
        },
      ]),
    );
    expect(out.startsWith("[Tool Result (bash)]: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    // prefix + 200 chars + "..."
    expect(out.length).toBe("[Tool Result (bash)]: ".length + 200 + 3);
  });

  it("emits [Tool Calls] but no [Assistant] when the assistant only made tool calls", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      ]),
    );
    expect(out).toContain("[User]: do it");
    expect(out).not.toContain("[Assistant]:");
    expect(out).toContain("[Tool Calls]:\n  Tool: search");
  });
});
