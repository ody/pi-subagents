import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSessionContext, createAgentSession, inMemory } = vi.hoisted(() => ({
  buildSessionContext: vi.fn(),
  createAgentSession: vi.fn(),
  inMemory: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    buildSessionContext,
    createAgentSession,
    SessionManager: { ...actual.SessionManager, inMemory },
  };
});

import { FORCED_BACKGROUND } from "../src/tool/invocation-config.js";
import { agentMentionReminder } from "../src/triggers/mention.js";
import { runMentionClone } from "../src/triggers/mention-clone.js";

const CONVERSATION = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "hello" }] },
] as any[];

beforeEach(() => {
  createAgentSession.mockReset();
  inMemory.mockReset();
  inMemory.mockReturnValue({ kind: "in-memory-session-manager" } as any);
  buildSessionContext.mockReset();
  buildSessionContext.mockReturnValue({ messages: CONVERSATION, thinkingLevel: "high", model: null } as any);
});

function mainCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    model: { id: "main-model" },
    thinkingLevel: "high",
    modelRegistry: { runtime: { kind: "runtime" } },
    getSystemPrompt: vi.fn(() => "the live system prompt"),
    sessionManager: {
      getEntries: vi.fn(() => [{ type: "message" }] as any[]),
      getLeafId: vi.fn(() => "leaf-1"),
    },
    ...overrides,
  } as any;
}

function agentTool() {
  return {
    name: "agent",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: {} })),
  } as any;
}

function visibleTools(opts: any): any[] {
  const allowed = opts.tools ?? (opts.noTools === "all" ? [] : undefined);
  const allowedSet = allowed ? new Set<string>(allowed) : undefined;
  const excluded = new Set<string>(opts.excludeTools ?? []);
  return (opts.customTools ?? []).filter(
    (tool: any) => (!allowedSet || allowedSet.has(tool.name)) && !excluded.has(tool.name),
  );
}

function cloneSession(turn?: (tool: any) => Promise<void> | void) {
  const session = {
    agent: { state: { systemPrompt: "rebuilt-from-cwd", messages: [] as any[] } },
    prompt: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as any;
  createAgentSession.mockImplementation(async (opts: any) => {
    const tools = visibleTools(opts);
    session.prompt.mockImplementation(async () => {
      if (tools.length === 0) return;
      await turn?.(tools[0]);
    });
    session.createdWith = opts;
    return { session };
  });
  return session;
}

const callsAgent = (params: Record<string, unknown> = { subagent_type: "Explore", prompt: "go" }) =>
  async (tool: any) => {
    await tool.execute("clone-tool-call-1", params, undefined, undefined, { cwd: "/fork" });
  };

const opts = (over: Record<string, unknown> = {}) => ({
  ctx: mainCtx(),
  type: "Explore",
  message: "find the flaky test",
  agentTool: agentTool(),
  ...over,
}) as any;

describe("cloning the conversation", () => {
  it("carries the conversation's own messages, not a rendering of them", async () => {
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(session.agent.state.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("takes the conversation from memory, never from the session file", async () => {
    const o = opts();
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(buildSessionContext).toHaveBeenCalledWith([{ type: "message" }], "leaf-1");
    expect(createAgentSession.mock.calls[0][0].sessionManager).toEqual({
      kind: "in-memory-session-manager",
    });
  });

  it("thinks at the level the session is really on", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(createAgentSession.mock.calls[0][0].thinkingLevel).toBe("high");
  });

  it("omits the level rather than taking buildSessionContext's, which lies", async () => {
    buildSessionContext.mockReturnValue({ messages: CONVERSATION, thinkingLevel: "off", model: null } as any);
    const o = opts({ ctx: mainCtx({ thinkingLevel: undefined }) });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("clones a conversation that has not started yet", async () => {
    buildSessionContext.mockReturnValue({ messages: [], thinkingLevel: "medium", model: null } as any);
    const o = opts();
    const session = cloneSession(callsAgent());

    const result = await runMentionClone(o);

    expect(result).toEqual({ spawned: true });
    expect(session.agent.state.messages).toEqual([]);
    expect(session.agent.state.systemPrompt).toBe("the live system prompt");
  });

  it("carries the live system prompt rather than the one it rebuilt", async () => {
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(session.agent.state.systemPrompt).toBe("the live system prompt");
  });

  it("inherits the parent's model, thinking level and providers", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.model).toEqual({ id: "main-model" });
    expect(built.thinkingLevel).toBe("high");
    expect(built.modelRuntime).toEqual({ kind: "runtime" });
  });

  it("gives the clone the agent tool and nothing else", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.customTools).toHaveLength(1);
    expect(built.customTools[0].name).toBe("agent");
    expect(visibleTools(built).map((tool: any) => tool.name)).toEqual(["agent"]);
  });

  it("names its own tool in the allowlist, or Pi hands it nothing", async () => {
    cloneSession(callsAgent());

    const result = await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.tools).toEqual(["agent"]);
    expect(built.noTools).toBeUndefined();
    expect(result).toEqual({ spawned: true });
  });

  it("prompts it with the message, then the reminder", async () => {
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(session.prompt).toHaveBeenCalledWith(
      `find the flaky test\n\n${agentMentionReminder("Explore")}`,
    );
  });
});

describe("attributing the spawn to the real session", () => {
  it("runs the real Agent handler with the MAIN context, not the fork's", async () => {
    const tool = agentTool();
    const o = opts({ agentTool: tool });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute.mock.calls[0][4]).toBe(o.ctx);
  });

  it("passes no tool-call id, since the real session issued none", async () => {
    const tool = agentTool();
    cloneSession(callsAgent());

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][0]).toBeUndefined();
  });

  it("forwards the parameters the clone chose", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Plan", prompt: "sketch the migration" }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toEqual({
      subagent_type: "Plan",
      prompt: "sketch the migration",
      [FORCED_BACKGROUND]: true,
    });
  });

  it("forces the spawn into the background without passing run_in_background, so it is not disclosed", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go" }));

    await runMentionClone(opts({ agentTool: tool }));

    const forwarded = tool.execute.mock.calls[0][1];
    expect(forwarded[FORCED_BACKGROUND]).toBe(true);
    expect(forwarded).not.toHaveProperty("run_in_background");
  });

  it("lets the clone set model and thinking from the user's words", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "review the ADR", model: "deepseek flash", thinking: "high" }));

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(result).toEqual({ spawned: true });
    expect(tool.execute.mock.calls[0][1]).toMatchObject({ model: "deepseek flash", thinking: "high" });
  });

  it("fills inherit_context, isolated, and isolation as on the main tool", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go", inherit_context: true, isolated: true, isolation: "worktree" }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({ inherit_context: true, isolated: true, isolation: "worktree" });
  });

  it.each([
    ["max_turns", 5],
    ["run_in_background", false],
    ["resume", "a1"],
    ["schedule", "5m"],
  ])("refuses %s, tells the clone, and reports it", async (name, value) => {
    const tool = agentTool();
    const captured: any[] = [];
    cloneSession(async (t) => {
      captured.push(await t.execute("c1", { subagent_type: "Explore", prompt: "go", [name]: value }, undefined, undefined, {}));
    });

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).not.toHaveBeenCalled();
    expect(captured[0].isError).toBe(true);
    expect(captured[0].content[0].text).toContain(name);
    expect(result.spawned).toBe(false);
    expect(result.refusal).toContain(name);
  });

  it("still spawns when the clone retries after a refusal", async () => {
    const tool = agentTool();
    cloneSession(async (t) => {
      await t.execute("c1", { subagent_type: "Explore", prompt: "go", max_turns: 3 }, undefined, undefined, {});
      await callsAgent()(t);
    });

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: true });
  });

  it("refuses a second spawn from the same mention", async () => {
    const tool = agentTool();
    cloneSession(async (t) => {
      await callsAgent()(t);
      await callsAgent()(t);
    });

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: true });
  });

  it("tells the clone why the second call was refused", async () => {
    const captured: any[] = [];
    cloneSession(async (t) => {
      await callsAgent()(t);
      captured.push(await t.execute("c2", { subagent_type: "Explore", prompt: "again" }, undefined, undefined, {}));
    });

    await runMentionClone(opts());

    expect(captured[0].isError).toBe(true);
    expect(captured[0].content[0].text).toContain("Already started an agent");
  });
});

describe("when the clone cannot deliver", () => {
  it("reports a turn that never called the tool", async () => {
    cloneSession();

    const result = await runMentionClone(opts());

    expect(result.spawned).toBe(false);
    expect(result.error).toContain("did not start it");
  });

  it("returns a thrown error rather than rejecting", async () => {
    createAgentSession.mockRejectedValue(new Error("no provider configured"));

    await expect(runMentionClone(opts())).resolves.toEqual({
      spawned: false,
      error: "no provider configured",
    });
  });

  it("keeps a spawn that already happened when the turn then fails", async () => {
    cloneSession(async (tool) => {
      await callsAgent()(tool);
      throw new Error("turn aborted");
    });

    const result = await runMentionClone(opts());

    expect(result).toEqual({ spawned: true, error: "turn aborted" });
  });

  it("disposes the clone even when the turn throws", async () => {
    const session = cloneSession(() => {
      throw new Error("turn aborted");
    });

    await runMentionClone(opts());

    expect(session.dispose).toHaveBeenCalled();
  });
});
