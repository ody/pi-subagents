import { afterEach, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../src/types.js";

const state = vi.hoisted(() => ({ records: [] as AgentRecord[], settle: undefined as ((record: AgentRecord) => void) | undefined }));

vi.mock("../../src/manager/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/manager/agent-manager.js")>("../../src/manager/agent-manager.js");
  return {
    ...actual,
    AgentManager: class extends actual.AgentManager {
      constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
        super(...args);
        state.settle = args[0];
      }
      override listAgents() { return state.records; }
      override abortAll() {
        for (const record of state.records) {
          if (record.status === "running" || record.status === "queued") {
            record.status = "stopped";
            record.stopCause = "shutdown";
            record.completedAt = 2;
          }
        }
        return state.records.length;
      }
    },
  };
});

import subagentsExtension from "../../src/index.js";

function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { id, type: "probe", description: "work", status: "running", startedAt: 1, ...overrides } as AgentRecord;
}

afterEach(() => { state.records = []; state.settle = undefined; });

it("records interrupted top-level runs once without events or notifications, even after a late settle", async () => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    on: vi.fn((name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  };
  const running = record("running", { sessionFile: "/session", handle: "probe-1", alias: "audit", agentConfig: { name: "probe", description: "work", systemPrompt: "prompt" } });
  const queued = record("queued", { status: "queued", handle: "probe-2" });
  const nested = record("nested", { parentAgentId: "running" });
  const finished = record("finished", { status: "completed" });
  state.records = [running, queued, nested, finished];
  subagentsExtension(pi as never);
  await handlers.get("session_shutdown")!();
  expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  expect(pi.appendEntry).toHaveBeenCalledWith("agent:record", expect.objectContaining({ id: "running", status: "stopped", stopCause: "shutdown", sessionFile: "/session", handle: "probe-1", alias: "audit", agentConfig: running.agentConfig }));
  expect(pi.appendEntry).toHaveBeenCalledWith("agent:record", expect.objectContaining({ id: "queued", status: "stopped", stopCause: "shutdown" }));
  const queuedEntry = pi.appendEntry.mock.calls.find(call => (call[1] as { id: string }).id === "queued")![1];
  expect(queuedEntry).not.toHaveProperty("handle");
  state.settle!(running);
  expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  expect(pi.events.emit).not.toHaveBeenCalled();
  expect(pi.sendMessage).not.toHaveBeenCalled();
});
