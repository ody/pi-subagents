/**
 * stop-subagent-wiring.test.ts — the `stop_subagent` tool: the model's only
 * lever to end a run, as opposed to a human's `x` in FleetView/the viewer/
 * `/agents`, or another extension's `subagents:rpc:stop`.
 *
 * Two things this tool must get right that its siblings don't have to:
 *
 *   - An already-terminal agent is success, not an error — the model's intent
 *     ("that agent is not running") is already satisfied.
 *   - It must NOT consume the result or cancel the pending nudge: `record.result`
 *     doesn't exist yet at stop time (the settle path hasn't run), so the
 *     completion notification — fired once the phase-1 forced-settle timer
 *     runs — is the only way the full output ever reaches the model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

const FORCED_SETTLE_GRACE_MS = 5_000;
const NUDGE_HOLD_MS = 200;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

/**
 * A runAgent that never settles, capturing the manager's own onTextDelta so a
 * test can simulate streamed partial output before the stop.
 */
function heldRun() {
  let deliverText: ((delta: string, fullText: string) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        deliverText = opts.onTextDelta;
      }) as any,
  );
  return {
    stream(fullText: string) {
      deliverText?.(fullText, fullText);
    },
  };
}

async function spawnBackground(
  tools: Map<string, any>,
  params: Record<string, unknown> = {},
): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "stop wiring agent", subagent_type: "Explore", run_in_background: true, ...params },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const stop = (tools: Map<string, any>, agent_id: string) =>
  tools.get("stop_subagent").execute("tc-stop", { agent_id }, undefined, undefined, ctx());

const managerRegistry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

/**
 * The raw `AgentManager` instance, reached the way the nested tools receive
 * it — the top-level registry (`managerRegistry()`) deliberately exposes only
 * `spawn`/`getRecord`/`waitForAll`/`hasRunning`, not `abort` or
 * `setMaxConcurrent`. Only available after at least one spawn.
 */
function rawManager(): any {
  return vi.mocked(runAgent).mock.calls[0][3].nestedRuntime.manager;
}

describe("stop_subagent", () => {
  it("stops a running background agent and leaves the record 'stopped'", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await stop(tools, id);
    expect(textOf(result)).toContain(id);
    expect(textOf(result)).toContain("stopped");
    expect(managerRegistry().getRecord(id).status).toBe("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("stops a queued agent before it starts, and says so", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    await spawnBackground(tools); // takes the only slot, once lowered below
    rawManager().setMaxConcurrent(1);
    const queuedId = await spawnBackground(tools);
    await flush();
    expect(managerRegistry().getRecord(queuedId).status).toBe("queued");

    const result = await stop(tools, queuedId);
    expect(textOf(result)).toContain("stopped before it started");
    expect(managerRegistry().getRecord(queuedId).status).toBe("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("reports an already-completed agent's terminal status, not an error", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done already",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const id = await spawnBackground(tools);
    await flush();
    expect(managerRegistry().getRecord(id).status).toBe("completed");

    const result = await stop(tools, id);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("completed");
    expect(textOf(result)).toContain("get_subagent_result");
    // Stopping an already-settled agent must not disturb its status.
    expect(managerRegistry().getRecord(id).status).toBe("completed");

    await lifecycle.get("session_shutdown")?.();
  });

  it("reports 'Agent not found' for an unknown id and for a nested child's id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const unknown = await stop(tools, "does-not-exist");
    expect(textOf(unknown)).toContain("Agent not found");

    // A nested child, spawned directly through the raw manager the way the
    // nested Agent tool does — hidden from every top-level surface.
    const topId = await spawnBackground(tools);
    await flush();
    const manager = rawManager();
    const childId = manager.spawn(pi, ctx(), "Explore", "nested", {
      description: "nested child",
      isBackground: true,
      parentAgentId: topId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    await flush();

    const nested = await stop(tools, childId);
    expect(textOf(nested)).toContain("Agent not found");
    // Untouched — the top-level tool must not reach through the ownership boundary.
    expect(manager.getRecord(childId)?.status).toBe("running");

    await lifecycle.get("session_shutdown")?.();
  });

  it("resolves a handle and an alias the same as an id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    await spawnBackground(tools);
    await flush();
    const byHandle = await stop(tools, "explore");
    expect(textOf(byHandle)).toContain("stopped");

    heldRun();
    await spawnBackground(tools, { name: "auth-audit" });
    await flush();
    const byAlias = await stop(tools, "auth-audit");
    expect(textOf(byAlias)).toContain("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("carries the streamed partial text in the reply", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.stream("partial thinking so far");

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("partial thinking so far");

    await lifecycle.get("session_shutdown")?.();
  });

  it("says plainly when the agent produced no text yet", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("No partial output");

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not consume the result or cancel the pending nudge — the notification still arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      heldRun();

      const id = await spawnBackground(tools);
      await flush();

      await stop(tools, id);
      expect(managerRegistry().getRecord(id).resultConsumed).toBeFalsy();

      // Nothing has notified yet — the forced-settle grace period hasn't
      // elapsed, so onComplete (and the nudge it schedules) hasn't fired.
      expect(pi.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(FORCED_SETTLE_GRACE_MS);
      await vi.advanceTimersByTimeAsync(NUDGE_HOLD_MS);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "subagent-notification" }),
        expect.anything(),
      );

      await lifecycle.get("session_shutdown")?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stoppedBy: 'agent' changes the note a following get_subagent_result reads back", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();
    await stop(tools, id);

    const readBack = await tools.get("get_subagent_result").execute(
      "tc-read", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(readBack)).toContain("STOPPED BY THE ORCHESTRATING AGENT");
    expect(textOf(readBack)).not.toContain("STOPPED BY THE USER");

    await lifecycle.get("session_shutdown")?.();
  });

  it("a UI-initiated stop still reads back as 'STOPPED BY THE USER'", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();
    // The FleetView/viewer/`/agents` path: manager.abort() directly, never
    // through stop_subagent, so stoppedBy is never set.
    rawManager().abort(id);

    const readBack = await tools.get("get_subagent_result").execute(
      "tc-read", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(readBack)).toContain("STOPPED BY THE USER");
    expect(textOf(readBack)).not.toContain("ORCHESTRATING AGENT");

    await lifecycle.get("session_shutdown")?.();
  });
});
