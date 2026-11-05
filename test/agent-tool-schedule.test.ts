import { describe, expect, it } from "vitest";
import { scheduleConflict } from "../src/tool/agent-tool-schedule.js";

const on = { schedulingEnabled: true, schedulerActive: true };

describe("scheduleConflict", () => {
  it("returns undefined when nothing conflicts", () => {
    expect(scheduleConflict({}, on)).toBeUndefined();
  });

  it("checks disabled scheduling first", () => {
    const msg = scheduleConflict({ resume: "a" }, { schedulingEnabled: false, schedulerActive: false });
    expect(msg).toContain("Scheduling is disabled");
  });

  it("rejects resume before inherit_context", () => {
    expect(scheduleConflict({ resume: "a", inherit_context: true }, on)).toContain("`resume`");
  });

  it("rejects inherit_context before foreground", () => {
    expect(scheduleConflict({ inherit_context: true, run_in_background: false }, on)).toContain("`inherit_context`");
  });

  it("rejects run_in_background false before an inactive scheduler", () => {
    const msg = scheduleConflict({ run_in_background: false }, { schedulingEnabled: true, schedulerActive: false });
    expect(msg).toContain("`run_in_background: false`");
  });

  it("rejects an inactive scheduler last", () => {
    expect(scheduleConflict({}, { schedulingEnabled: true, schedulerActive: false })).toContain(
      "Scheduler is not active",
    );
  });
});
