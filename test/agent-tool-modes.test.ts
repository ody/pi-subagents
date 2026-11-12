import { describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agents/agent-types.js";
import { type AgentToolDeps, createAgentTool } from "../src/tool/agent-tool.js";

function setup(over: { settings?: Partial<AgentToolDeps["settings"]>; records?: Record<string, any>; scheduler?: any } = {}) {
  const records: Record<string, any> = over.records ?? {};
  const manager = {
    getRecord: vi.fn((id: string) => records[id]),
    getMaxConcurrent: vi.fn(() => 4),
    resume: vi.fn(),
    spawn: vi.fn((_pi: any, _ctx: any, _type: string, _prompt: string, _opts: any) => {
      records.new1 = { id: "new1", status: "running", type: "general-purpose" };
      return "new1";
    }),
    awaitStartup: vi.fn(async () => {}),
    getActivity: vi.fn(),
    listAgents: vi.fn(() => []),
    spawnAndWait: vi.fn(),
  };
  const scheduler = over.scheduler ?? {
    isActive: vi.fn(() => true),
    addJob: vi.fn(() => ({ id: "job1", name: "d", scheduleType: "interval" })),
    getNextRun: vi.fn(() => "soon"),
  };
  const notifier = { addToBatch: vi.fn() };
  const startBackgroundResume = vi.fn();
  const pi = { events: { emit: vi.fn(), on: vi.fn() } } as any;
  const deps: AgentToolDeps = {
    manager: manager as any,
    scheduler,
    widget: { setUICtx: vi.fn(), ensureTimer: vi.fn(), update: vi.fn(), markFinished: vi.fn() } as any,
    fleet: { ensureTimer: vi.fn(), update: vi.fn(), onAgentFinished: vi.fn() } as any,
    notifier,
    startBackgroundResume,
    reloadCustomAgents: vi.fn(),
    settings: {
      schedulingEnabled: true,
      toolDescriptionMode: "compact",
      backgroundByDefault: true,
      defaultJoinMode: "smart",
      showCost: false,
      ...over.settings,
    } as any,
  };
  registerAgents(new Map());
  const tool = createAgentTool(pi, deps);
  const ctx = {
    ui: { notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
    sessionManager: { getSessionId: () => "sess" },
  } as any;
  const run = (params: Record<string, unknown>) =>
    tool.execute(
      "tc1",
      { prompt: "p", description: "desc", subagent_type: "general-purpose", ...params } as any,
      undefined,
      undefined,
      ctx,
    );
  const text = (r: any) => r.content[0].text as string;
  return { run, text, manager, scheduler, notifier, startBackgroundResume, pi };
}

describe("Agent tool resume", () => {
  it("reports an unknown agent", async () => {
    const { run, text } = setup();
    expect(text(await run({ resume: "nope" }))).toBe('Agent not found: "nope". It may have been cleaned up.');
  });

  it("reports an agent without a session", async () => {
    const { run, text } = setup({ records: { a1: { id: "a1", type: "general-purpose", status: "completed" } } });
    expect(text(await run({ resume: "a1" }))).toBe('Agent "a1" has no active session to resume.');
  });

  it("reports a failed foreground resume", async () => {
    const { run, text, manager } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "completed", session: {} } },
    });
    manager.resume.mockResolvedValue(undefined);
    expect(text(await run({ resume: "a1", run_in_background: false }))).toBe('Failed to resume agent "a1".');
  });

  it("surfaces an errored foreground resume", async () => {
    const { run, text, manager } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "completed", session: {} } },
    });
    manager.resume.mockResolvedValue({ id: "a1", type: "general-purpose", status: "error", error: "boom" });
    expect(text(await run({ resume: "a1", run_in_background: false }))).toContain("Agent failed: boom");
  });

  it("returns the foreground resume result", async () => {
    const { run, text, manager } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "completed", session: {} } },
    });
    manager.resume.mockResolvedValue({ id: "a1", type: "general-purpose", status: "completed", result: " done " });
    expect(text(await run({ resume: "a1", run_in_background: false }))).toBe("done");
  });

  it("refuses a background resume of a running agent", async () => {
    const { run, text, startBackgroundResume } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "running", session: {} } },
    });
    expect(text(await run({ resume: "a1" }))).toContain("is still running");
    expect(startBackgroundResume).not.toHaveBeenCalled();
  });

  it("reports a failed background resume", async () => {
    const { run, text, startBackgroundResume } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "completed", session: {} } },
    });
    startBackgroundResume.mockResolvedValue(undefined);
    expect(text(await run({ resume: "a1" }))).toBe('Failed to resume agent "a1".');
  });

  it("reports a queued background resume", async () => {
    const { run, text, startBackgroundResume } = setup({
      records: { a1: { id: "a1", type: "general-purpose", status: "completed", session: {} } },
    });
    startBackgroundResume.mockResolvedValue({ id: "a1", status: "queued", toolUses: 0 });
    const out = text(await run({ resume: "a1" }));
    expect(out).toContain("Agent queued in background.");
    expect(out).toContain("Position: queued (max 4 concurrent)");
  });
});

describe("Agent tool schedule", () => {
  it("refuses when scheduling is disabled", async () => {
    const { run, text } = setup({ settings: { schedulingEnabled: false } });
    expect(text(await run({ schedule: "5m" }))).toContain("Scheduling is disabled");
  });

  it("refuses an inactive scheduler", async () => {
    const { run, text } = setup({
      scheduler: { isActive: () => false, addJob: vi.fn(), getNextRun: vi.fn() },
    });
    expect(text(await run({ schedule: "5m" }))).toContain("Scheduler is not active");
  });

  it("registers a job", async () => {
    const { run, text, scheduler } = setup();
    const out = text(await run({ schedule: "5m" }));
    expect(out).toContain('Scheduled "d" (id: job1, type: interval). Next run: soon.');
    expect(scheduler.addJob).toHaveBeenCalledWith(expect.objectContaining({ schedule: "5m", prompt: "p" }));
  });

  it("returns an addJob error as text", async () => {
    const { run, text, scheduler } = setup();
    scheduler.addJob.mockImplementation(() => {
      throw new Error("bad cron");
    });
    expect(text(await run({ schedule: "x" }))).toBe("bad cron");
  });
});

describe("Agent tool background spawn", () => {
  it("joins the batch and tells the model not to duplicate", async () => {
    const { run, text, notifier, manager, pi } = setup();
    const out = text(await run({}));
    expect(out).toContain("Agent started in background.");
    expect(out).toContain("Agent ID: new1");
    expect(out).toContain("Do not duplicate this agent's work.");
    expect(notifier.addToBatch).toHaveBeenCalledWith("new1", "smart");
    expect(manager.awaitStartup).toHaveBeenCalledWith("new1");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:created", expect.objectContaining({ id: "new1", isBackground: true }));
  });

  it("wires toolCallId and joinMode on the record", async () => {
    const { run, manager } = setup();
    await run({});
    const rec = manager.getRecord("new1");
    expect(rec.joinMode).toBe("smart");
    expect(rec.toolCallId).toBe("tc1");
  });

  it("lets spawn errors throw", async () => {
    const { run, manager } = setup();
    manager.spawn.mockImplementation(() => {
      throw new Error("no spawn");
    });
    await expect(run({})).rejects.toThrow("no spawn");
  });

  it("lets awaitStartup errors throw", async () => {
    const { run, manager } = setup();
    manager.awaitStartup.mockRejectedValue(new Error("worktree"));
    await expect(run({})).rejects.toThrow("worktree");
  });
});
