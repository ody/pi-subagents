import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runAgent, steerAgent } from "../src/session/agent-runner.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

beforeEach(() => {
  vi.mocked(steerAgent).mockReset();
  vi.mocked(runAgent).mockReset();
});

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

function heldRun() {
  let createSession: ((session: any) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        createSession = (session: any) => opts.onSessionCreated?.(session);
      }) as any,
  );
  return {
    create(session: any) {
      createSession?.(session);
    },
  };
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "steer wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const steer = (tools: Map<string, any>, agent_id: string, message: string) =>
  tools.get("steer_subagent").execute("tc-steer", { agent_id, message }, undefined, undefined, ctx());

describe("steer_subagent before the session exists", () => {
  it("queues the message on the record and says so", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await steer(tools, id, "change course");
    expect(textOf(result)).toContain("queued");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "change course" });

    await lifecycle.get("session_shutdown")?.();
  });

  it("appends a second queued steer instead of replacing the first", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();

    await steer(tools, id, "first");
    await steer(tools, id, "second");

    const sessionSteer = vi.fn().mockResolvedValue(undefined);
    run.create(fakeSession({ steer: sessionSteer }));
    await flush();

    expect(sessionSteer.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not call steerAgent — there is no session to steer yet", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();
    await steer(tools, id, "hello");

    expect(steerAgent).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("steer_subagent once the session exists", () => {
  it("reports failure and emits no event when the steer throws", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockRejectedValueOnce(new Error("session closed"));
    const result = await steer(tools, id, "too late");

    expect(textOf(result)).toContain("Failed to steer agent");
    expect(textOf(result)).toContain("session closed");
    expect(pi.events.emit).not.toHaveBeenCalledWith(
      "subagents:steered",
      expect.objectContaining({ message: "too late" }),
    );

    await lifecycle.get("session_shutdown")?.();
  });

  it("delivers through steerAgent and announces the steer on success", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockResolvedValueOnce(undefined as any);
    const result = await steer(tools, id, "refocus");

    expect(steerAgent).toHaveBeenCalledWith(expect.anything(), "refocus");
    expect(textOf(result)).toContain("Steering message sent");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "refocus" });

    await lifecycle.get("session_shutdown")?.();
  });
});
