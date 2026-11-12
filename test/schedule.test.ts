import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agents/agent-types.js";
import { SubagentScheduler } from "../src/triggers/schedule.js";
import { ScheduleStore } from "../src/triggers/schedule-store.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  return {
    spawn: spawnFn,
    awaitStartup: vi.fn(async () => {}),
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  } as any;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as any;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as any;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "general-purpose", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0].enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  it("getNextRun uses lastRun when present for interval jobs", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString();
    scheduler.updateJob(job.id, { lastRun });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(new Date(new Date(lastRun).getTime() + 3_600_000).toISOString());
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/in the past/);
    expect(scheduler.list()).toEqual([]);
  });

  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "reload-test", error: expect.stringMatching(/in the past/),
    }));
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    setFallbackSubagent(undefined);
    registerAgents(new Map());
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });

    expect(manager.spawn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("refuses at fire time when the job's agent type no longer resolves", () => {
    registerAgents(new Map());
    setFallbackSubagent(NO_FALLBACK);
    const job = scheduler.addJob({
      name: "gone", description: "vanished agent", schedule: "+1s",
      subagent_type: "deleted-since", prompt: "run",
    });

    vi.advanceTimersByTime(2_000);

    expect(manager.spawn).not.toHaveBeenCalled();
    const stored = store.get(job.id);
    expect(stored?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:scheduled",
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("Unknown or disabled agent type"),
      }),
    );
  });

  it("one-shot fires once and auto-disables", async () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });

    vi.advanceTimersByTime(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("fire passes bypassQueue: true to manager.spawn", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("fire passes the job's configuration as the invocation snapshot", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
      thinking: "high", max_turns: 12, isolated: true,
    });

    vi.advanceTimersByTime(1_000);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.invocation).toEqual({
      thinking: "high",
      maxTurns: 12,
      isolated: true,
      runInBackground: true,
      isolation: undefined,
    });
  });

  it("fire normalizes an unlimited turn budget out of the snapshot", () => {
    scheduler.addJob({
      name: "unlimited", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x", max_turns: 0,
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn.mock.calls[0][4].invocation.maxTurns).toBeUndefined();
  });

  describe("caller overrides (version 2) and legacy jobs (version 1)", () => {
    const MODELS = [
      { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ];

    beforeEach(() => {
      registerAgents(new Map([["tuned", {
        name: "tuned",
        description: "tuned",
        builtinToolNames: ["read"],
        extensions: false,
        skills: false,
        systemPrompt: "x",
        promptMode: "replace",
        inheritContext: false,
        model: "anthropic/claude-haiku-4-5",
        thinking: "low",
        maxTurns: 20,
        runInBackground: false,
      } as any]]));
      ctx.modelRegistry = {
        find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
        getAll: () => MODELS,
        getAvailable: () => MODELS,
      };
    });

    function fire(job: Record<string, unknown>) {
      store.add({
        id: "j1", name: "j1", description: "x", schedule: "1s", scheduleType: "interval", intervalMs: 1000,
        subagent_type: "tuned", prompt: "x", enabled: true, createdAt: new Date().toISOString(), runCount: 0,
        ...job,
      } as any);
      scheduler.stop();
      scheduler.start(pi, ctx, manager, store);
      vi.advanceTimersByTime(1_000);
    }

    it("stores new jobs as version 2 with the caller's raw values", () => {
      const job = scheduler.addJob({
        name: "raw", description: "x", schedule: "1h", subagent_type: "tuned", prompt: "x",
        model: "opus", thinking: "high", max_turns: 0, run_in_background: true,
      });

      expect(job).toMatchObject({
        version: 2, model: "opus", thinking: "high", max_turns: 0, run_in_background: true,
      });
    });

    it("resolves a version 2 job's overrides over the file when it fires, and discloses them", () => {
      fire({ version: 2, model: "anthropic/claude-opus-4-6", thinking: "high", max_turns: 5, run_in_background: true });

      const opts = manager.spawn.mock.calls[0][4];
      expect(opts.model).toMatchObject({ id: "claude-opus-4-6" });
      expect(opts.thinkingLevel).toBe("high");
      expect(opts.maxTurns).toBe(5);
      expect(opts.invocation).toMatchObject({
        thinking: "high",
        maxTurns: 5,
        runInBackground: true,
        pinnedModel: "anthropic/claude-haiku-4-5",
        pinnedThinking: "low",
        pinnedMaxTurns: 20,
        pinnedRunInBackground: false,
      });
    });

    it("fires a version 2 job with an explicit unlimited as unlimited, not the file's limit", () => {
      fire({ version: 2, max_turns: 0 });

      const opts = manager.spawn.mock.calls[0][4];
      expect(opts.maxTurns).toBe(0);
      expect(opts.invocation.maxTurns).toBeUndefined();
    });

    it("ignores a version 1 job's thinking and max_turns and resolves them from the file", () => {
      fire({ thinking: "high", max_turns: 5 });

      const opts = manager.spawn.mock.calls[0][4];
      expect(opts.thinkingLevel).toBe("low");
      expect(opts.maxTurns).toBe(20);
    });

    it("resolves a version 1 job's thinking and max_turns from the fallbacks when the file is silent", () => {
      registerAgents(new Map());
      fire({ subagent_type: "general-purpose", thinking: "high", max_turns: 5 });

      const opts = manager.spawn.mock.calls[0][4];
      expect(opts.thinkingLevel).toBeUndefined();
      expect(opts.maxTurns).toBeUndefined();
    });

    it("still honours a version 1 job's model", () => {
      fire({ model: "anthropic/claude-opus-4-6" });

      expect(manager.spawn.mock.calls[0][4].model).toMatchObject({ id: "claude-opus-4-6" });
    });

    it("fails the firing without spawning when the stored model no longer resolves", () => {
      fire({ version: 2, model: "gone/vanished" });

      expect(manager.spawn).not.toHaveBeenCalled();
      expect(store.get("j1")?.lastStatus).toBe("error");
      expect(pi.events.emit).toHaveBeenCalledWith(
        "subagents:scheduled",
        expect.objectContaining({ type: "error", jobId: "j1" }),
      );
    });

    it("does not fall back to the agent's pin when the stored model no longer resolves", () => {
      fire({ model: "gone/vanished" });

      expect(manager.spawn).not.toHaveBeenCalled();
    });
  });

  it("disabled jobs do not fire", () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "fired", name: "fire-once", agentId: expect.stringMatching(/^agent-/),
    }));
  });

  it("records lastStatus error and emits when manager.spawn throws", async () => {
    manager.spawn.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  it("records lastStatus error when the agent fails to start after spawn returns", async () => {
    manager.awaitStartup.mockRejectedValueOnce(new Error('Cannot run with isolation: "worktree"'));
    const job = scheduler.addJob({
      name: "no-worktree", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x", isolation: "worktree",
    });
    vi.advanceTimersByTime(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
  });

  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      manager.spawn.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      expect(manager.spawn).toHaveBeenCalledTimes(1);

      const r = [...records.values()][0];
      r.status = "error";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      const r = [...records.values()][0];
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(3_000);
      const recs = [...records.values()];
      recs[0].status = "aborted";
      recs[0].resolve();
      recs[1].status = "stopped";
      recs[1].resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});
