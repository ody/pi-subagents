import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingUsagePool } from "../../src/usage.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("subagent usage reaches the parent session's stats (real pi)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-usage-e2e-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function realSession() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model: model as any,
      modelRegistry: backend.modelRegistry,
      modelRuntime: backend.modelRuntime,
      tools: [],
    } as any);
    return session;
  }

  function toolResultCarrying(usage: unknown) {
    return {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "Agent",
      content: [{ type: "text" as const, text: "Agent completed." }],
      isError: false,
      timestamp: 1,
      usage,
    };
  }

  it("pi adds our reported tokens and cost to getSessionStats()", async () => {
    const session = await realSession();
    try {
      const before = session.getSessionStats();

      const pool = new PendingUsagePool();
      pool.add({ input: 1000, output: 400, cacheWrite: 100, cacheRead: 9000, cost: 0.0123 });
      pool.add({ input: 2000, output: 600, cacheWrite: 200, cacheRead: 18_000, cost: 0.0077 });
      const usage = pool.drain();

      session.sessionManager.appendMessage(toolResultCarrying(usage) as any);
      const after = session.getSessionStats();

      expect(after.tokens.input - before.tokens.input).toBe(3000);
      expect(after.tokens.output - before.tokens.output).toBe(1000);
      expect(after.tokens.cacheWrite - before.tokens.cacheWrite).toBe(300);
      expect(after.tokens.cacheRead - before.tokens.cacheRead).toBe(27_000);

      expect(after.cost - before.cost).toBeCloseTo(0.02, 10);
    } finally {
      session.dispose?.();
    }
  });

  it("leaves the context-window percentage alone", async () => {
    const session = await realSession();
    try {
      const before = session.getSessionStats().contextUsage?.percent ?? null;

      const pool = new PendingUsagePool();
      pool.add({ input: 150_000, output: 400, cacheWrite: 100, cost: 1.5 });
      session.sessionManager.appendMessage(toolResultCarrying(pool.drain()) as any);

      expect(session.getSessionStats().contextUsage?.percent ?? null).toBe(before);
    } finally {
      session.dispose?.();
    }
  });

  it("counts nothing for a tool result that carries no usage", async () => {
    const session = await realSession();
    try {
      const before = session.getSessionStats();
      session.sessionManager.appendMessage(toolResultCarrying(undefined) as any);
      const after = session.getSessionStats();

      expect(after.tokens.input).toBe(before.tokens.input);
      expect(after.cost).toBe(before.cost);
    } finally {
      session.dispose?.();
    }
  });
});
