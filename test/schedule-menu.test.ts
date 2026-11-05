import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentScheduler } from "../src/triggers/schedule.js";
import { ScheduleStore } from "../src/triggers/schedule-store.js";
import { showSchedulesMenu } from "../src/ui/schedule-menu.js";

function makeCtx(opts: { pick?: (labels: string[]) => string | undefined; confirm?: boolean } = {}) {
  const notify = vi.fn();
  const select = vi.fn(async (_title: string, labels: string[]) => opts.pick?.(labels));
  const confirm = vi.fn(async () => opts.confirm ?? true);
  return { ctx: { ui: { select, confirm, notify } } as any, select, confirm, notify };
}

describe("showSchedulesMenu", () => {
  let dir: string;
  let scheduler: SubagentScheduler;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-schedmenu-"));
    scheduler = new SubagentScheduler();
    scheduler.start(
      { events: { emit: vi.fn() } } as any,
      { cwd: dir } as any,
      { spawn: vi.fn(), getRecord: vi.fn() } as any,
      new ScheduleStore(join(dir, "jobs.json")),
    );
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const addJob = (name: string) =>
    scheduler.addJob({
      name,
      description: name,
      schedule: "0 0 9 * * 1",
      subagent_type: "general-purpose",
      prompt: "go",
    });

  it("warns and does nothing when the scheduler is not active", async () => {
    const idle = new SubagentScheduler();
    const { ctx, select, notify } = makeCtx();
    await showSchedulesMenu(ctx, idle);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not active"), "warning");
  });

  it("reports an empty list without opening a picker", async () => {
    const { ctx, select, notify } = makeCtx();
    await showSchedulesMenu(ctx, scheduler);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("No scheduled jobs.", "info");
  });

  it("cancels the job the user selected", async () => {
    const a = addJob("alpha job");
    const b = addJob("beta job");
    const { ctx } = makeCtx({ pick: (labels) => labels[1] });

    await showSchedulesMenu(ctx, scheduler);

    expect(scheduler.list().map(j => j.id)).toEqual([a.id]);
    expect(scheduler.list().map(j => j.id)).not.toContain(b.id);
  });

  describe("rows that format identically after truncation", () => {
    const NAME_A = "review the auth module A";
    const NAME_B = "review the auth module B";

    it("gives every row a distinct label", () => {
      addJob(NAME_A);
      addJob(NAME_B);
      const { ctx, select } = makeCtx({ pick: () => undefined });
      return showSchedulesMenu(ctx, scheduler).then(() => {
        const labels = select.mock.calls[0][1] as string[];
        expect(new Set(labels).size).toBe(labels.length);
      });
    });

    it("cancels the second job when the second row is picked", async () => {
      const first = addJob(NAME_A);
      const second = addJob(NAME_B);
      const { ctx } = makeCtx({ pick: (labels) => labels[1] });

      await showSchedulesMenu(ctx, scheduler);

      expect(scheduler.list().map(j => j.id)).toEqual([first.id]);
      expect(scheduler.list().map(j => j.id)).not.toContain(second.id);
    });

    it("cancels the first job when the first row is picked", async () => {
      const first = addJob(NAME_A);
      const second = addJob(NAME_B);
      const { ctx } = makeCtx({ pick: (labels) => labels[0] });

      await showSchedulesMenu(ctx, scheduler);

      expect(scheduler.list().map(j => j.id)).toEqual([second.id]);
      expect(scheduler.list().map(j => j.id)).not.toContain(first.id);
    });

    it("shows the SELECTED job's untruncated details in the confirm dialog", async () => {
      addJob(NAME_A);
      addJob(NAME_B);
      const { ctx, confirm } = makeCtx({ pick: (labels) => labels[1] });

      await showSchedulesMenu(ctx, scheduler);

      expect(confirm.mock.calls[0][0]).toContain(NAME_B);
      expect(confirm.mock.calls[0][0]).not.toContain(NAME_A);
    });

    it("cancels the right job past the single-digit boundary", async () => {
      const jobs = Array.from({ length: 11 }, (_, i) => addJob(`review the auth module ${i}`));
      const { ctx } = makeCtx({ pick: (labels) => labels[10] });

      await showSchedulesMenu(ctx, scheduler);

      const surviving = scheduler.list().map(j => j.id);
      expect(surviving).toHaveLength(10);
      expect(surviving).not.toContain(jobs[10].id);
    });
  });

  it("cancels nothing when the picker returns a label we never offered", async () => {
    addJob("alpha job");
    const { ctx, confirm } = makeCtx({ pick: () => "something else entirely" });

    await showSchedulesMenu(ctx, scheduler);

    expect(confirm).not.toHaveBeenCalled();
    expect(scheduler.list()).toHaveLength(1);
  });

  it("leaves every job intact when the user escapes the picker", async () => {
    addJob("alpha job");
    addJob("beta job");
    const { ctx, confirm } = makeCtx({ pick: () => undefined });

    await showSchedulesMenu(ctx, scheduler);

    expect(confirm).not.toHaveBeenCalled();
    expect(scheduler.list()).toHaveLength(2);
  });

  it("leaves the job intact when the user declines the confirm", async () => {
    addJob("alpha job");
    const { ctx, notify } = makeCtx({ pick: (labels) => labels[0], confirm: false });

    await showSchedulesMenu(ctx, scheduler);

    expect(scheduler.list()).toHaveLength(1);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Cancelled"), "info");
  });
});
