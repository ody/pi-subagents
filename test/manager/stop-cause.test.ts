import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, normalizeInlineAgentConfig, registerRpcHandlers } from "../../src/triggers/cross-extension-rpc.js";
import { createSpawnFunnel } from "../../src/triggers/spawn-funnel.js";
import type { StopCause } from "../../src/types.js";
import { GrantingAgentManager as AgentManager } from "../harness/capability.js";

vi.mock("../../src/session/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { resumeAgent, runAgent } from "../../src/session/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const GRACE = 5_000;

function wedge() {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
}

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("stopCause", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    manager = new AgentManager(undefined, 1);
    wedge();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  const spawnBackground = (extra: Record<string, unknown> = {}) =>
    manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: true, ...extra });

  describe("abort(id, cause)", () => {
    it.each(["user", "agent", "extension", "owner", "shutdown"] as StopCause[])("records %s on a running run", (cause) => {
      const id = spawnBackground();
      expect(manager.getRecord(id)?.status).toBe("running");

      expect(manager.abort(id, cause)).toBe(true);

      expect(manager.getRecord(id)?.status).toBe("stopped");
      expect(manager.getRecord(id)?.stopCause).toBe(cause);
    });

    it("records the cause on a queued run", () => {
      spawnBackground();
      const queued = spawnBackground();
      expect(manager.getRecord(queued)?.status).toBe("queued");

      expect(manager.abort(queued, "agent")).toBe(true);

      expect(manager.getRecord(queued)?.stopCause).toBe("agent");
    });

    it("keeps the first cause when a run is stopped twice", () => {
      const id = spawnBackground();
      manager.abort(id, "user");

      expect(manager.abort(id, "agent")).toBe(false);

      expect(manager.getRecord(id)?.stopCause).toBe("user");
    });

    it("leaves stopCause unset on a run that was not stopped", async () => {
      vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
      const id = spawnBackground();
      await manager.getRecord(id)?.promise;

      expect(manager.getRecord(id)?.status).toBe("completed");
      expect(manager.getRecord(id)?.stopCause).toBeUndefined();
    });
  });

  describe("owner", () => {
    it("is set on a child when its owner settles", async () => {
      const parentId = spawnBackground();
      const childId = manager.spawn(mockPi, mockCtx, "Y", "child", { description: "d", parentAgentId: parentId, isBackground: true });

      manager.abort(parentId, "user");
      await vi.advanceTimersByTimeAsync(GRACE);

      expect(manager.getRecord(parentId)?.stopCause).toBe("user");
      expect(manager.getRecord(childId)?.status).toBe("stopped");
      expect(manager.getRecord(childId)?.stopCause).toBe("owner");
    });
  });

  describe("shutdown", () => {
    it("abortAll sets it on running and queued runs", () => {
      const running = spawnBackground();
      const queued = spawnBackground();

      expect(manager.abortAll()).toBe(2);

      expect(manager.getRecord(running)?.stopCause).toBe("shutdown");
      expect(manager.getRecord(queued)?.stopCause).toBe("shutdown");
    });
  });

  describe("spawn signal", () => {
    it.each(["user", "owner"] as StopCause[])("an abort of a %s signal records that cause", (cause) => {
      const controller = new AbortController();
      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "d", isBackground: false, signal: controller.signal, signalCause: cause });

      controller.abort();

      expect(manager.getRecord(id)?.status).toBe("stopped");
      expect(manager.getRecord(id)?.stopCause).toBe(cause);
    });

    it("an abort of a signal on a queued run records the signal cause", () => {
      spawnBackground();
      const controller = new AbortController();
      const queued = spawnBackground({ signal: controller.signal, signalCause: "owner" });
      expect(manager.getRecord(queued)?.status).toBe("queued");

      controller.abort();

      expect(manager.getRecord(queued)?.stopCause).toBe("owner");
    });

    it.each(["user", "extension", "owner"] as StopCause[])("a signal already aborted at spawn gives its owner's cause %s", (cause) => {
      const id = spawnBackground({ signal: AbortSignal.abort(), signalCause: cause });
      expect(manager.getRecord(id)?.status).toBe("stopped");
      expect(manager.getRecord(id)?.stopCause).toBe(cause);
    });

    it.each(["user", "owner"] as StopCause[])("a queued spawn with a signal already aborted gives %s", (cause) => {
      spawnBackground();
      const queued = spawnBackground({ signal: AbortSignal.abort(), signalCause: cause });

      expect(manager.getRecord(queued)?.status).toBe("stopped");
      expect(manager.getRecord(queued)?.stopCause).toBe(cause);
    });

    it("a spawn with a signal and no signalCause throws", () => {
      expect(() => spawnBackground({ signal: new AbortController().signal })).toThrow(/signalCause/);
    });
  });

  describe("resume", () => {
    async function stoppedWithSession(cause: StopCause) {
      let finish!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
      vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const id = spawnBackground();
      manager.abort(id, cause);
      finish({ responseText: "late", session: { dispose: vi.fn() } as any, aborted: true, steered: false });
      await manager.getRecord(id)?.promise;
      return id;
    }

    it("clears the cause of the earlier stop", async () => {
      const id = await stoppedWithSession("user");
      expect(manager.getRecord(id)?.stopCause).toBe("user");
      vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

      await manager.resume(id, "again", undefined, { isBackground: true });

      expect(manager.getRecord(id)?.status).toBe("running");
      expect(manager.getRecord(id)?.stopCause).toBeUndefined();
    });

    it("an abort of the resume's signal records the signal cause", async () => {
      const id = await stoppedWithSession("agent");
      vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
      const controller = new AbortController();

      await manager.resume(id, "again", controller.signal, { isBackground: true, signalCause: "owner" });
      controller.abort();

      expect(manager.getRecord(id)?.status).toBe("stopped");
      expect(manager.getRecord(id)?.stopCause).toBe("owner");
    });

    it("a resume with a signal and no signalCause throws", async () => {
      const id = await stoppedWithSession("agent");

      await expect(manager.resume(id, "again", new AbortController().signal)).rejects.toThrow(/signalCause/);
    });
  });

  describe("extension", () => {
    const agentConfig = (type: string) => normalizeInlineAgentConfig(type, { systemPrompt: "p", extensions: false, skills: false, builtinToolNames: [] });

    function wire() {
      const events = createEventBus();
      const funnel = createSpawnFunnel({ manager, reloadCustomAgents: () => {} });
      registerRpcHandlers({
        events,
        pi: { events },
        getCtx: () => mockCtx,
        manager: {
          spawn: funnel.spawnTopLevel,
          awaitStartup: id => manager.awaitStartup(id),
          abort: (id, cause) => manager.abort(id, cause),
          getRecord: id => manager.getRecord(id),
          consumeResult: () => false,
        },
      });
      return { events, funnel };
    }

    it("agent:rpc:stop records it", async () => {
      const { events } = wire();
      const id = spawnBackground();
      const reply = vi.fn();
      events.on("agent:rpc:stop:reply:r1", reply);

      events.emit("agent:rpc:stop", { requestId: "r1", agentId: id });
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));

      expect(manager.getRecord(id)?.stopCause).toBe("extension");
    });

    it("an aborted spawn signal from the top-level spawn path records it", () => {
      const { funnel } = wire();
      const controller = new AbortController();

      const id = funnel.spawnTopLevel(mockPi, mockCtx, "probe", "go", {
        description: "d",
        isBackground: true,
        signal: controller.signal,
        signalCause: "user",
        agentConfig: agentConfig("probe"),
      });
      controller.abort();

      expect(manager.getRecord(id)?.status).toBe("stopped");
      expect(manager.getRecord(id)?.stopCause).toBe("extension");
    });

    it("a top-level spawn signal already aborted records it", () => {
      const { funnel } = wire();

      const id = funnel.spawnTopLevel(mockPi, mockCtx, "probe", "go", {
        description: "d",
        isBackground: true,
        signal: AbortSignal.abort(),
        agentConfig: agentConfig("probe"),
      });

      expect(manager.getRecord(id)?.stopCause).toBe("extension");
    });
  });
});
