import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { resolveStorePath, ScheduleStore } from "../src/triggers/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const SESSION_ID = "sched-wiring-session";
const AGENT_FILES = { "general-purpose": "---\ndescription: general-purpose\n---\n\nYou are general-purpose." };

function bootedCtx() {
  return ctx({
    sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
  });
}

async function scheduleAndReadBack(
  params: Record<string, unknown>,
): Promise<{ job: ScheduledSubagent; reply: string; restore: () => void }> {
  const hermetic = hermeticDir({ agentFiles: AGENT_FILES });
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);

  const c = bootedCtx();
  await lifecycle.get("session_start")?.({}, c);

  const reply = textOf(
    await tools.get("agent").execute(
      "tc-sched",
      { prompt: "do the thing", description: "nightly sweep", schedule: "0 3 * * * *", ...params },
      undefined,
      undefined,
      c,
    ),
  );

  const store = new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID));
  const jobs = store.list();
  await lifecycle.get("session_shutdown")?.();
  expect(jobs, `expected one persisted job, reply was: ${reply}`).toHaveLength(1);
  return { job: jobs[0], reply, restore: hermetic.restore };
}

describe("agent tool → persisted scheduled job", () => {
  it("persists the run-shaping params the job will fire with", async () => {
    const { job, restore } = await scheduleAndReadBack({
      subagent_type: "general-purpose",
      thinking: "high",
      isolated: true,
      isolation: "worktree",
    });
    try {
      expect(job.thinking).toBe("high");
      expect(job.isolated).toBe(true);
      expect(job.isolation).toBe("worktree");
      expect(job.prompt).toBe("do the thing");
      expect(job.enabled).toBe(true);
    } finally {
      restore();
    }
  });

  it("persists the caller's raw turn limit as a version 2 job", async () => {
    const { job, restore } = await scheduleAndReadBack({
      subagent_type: "general-purpose",
      max_turns: 0,
    });
    try {
      expect(job.max_turns).toBe(0);
      expect(job.version).toBe(2);
    } finally {
      restore();
    }
  });

  it("leaves the turn limit unset when the call omits one, to resolve when the job fires", async () => {
    const { job, restore } = await scheduleAndReadBack({ subagent_type: "general-purpose" });
    try {
      expect(job.max_turns).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("refuses an unknown subagent_type instead of persisting a job", async () => {
    const hermetic = hermeticDir();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const c = bootedCtx();
    await lifecycle.get("session_start")?.({}, c);
    try {
      const reply = textOf(
        await tools.get("agent").execute(
          "tc-sched",
          { prompt: "x", description: "nightly sweep", schedule: "0 3 * * * *", subagent_type: "does-not-exist" },
          undefined,
          undefined,
          c,
        ),
      );
      expect(reply).toContain('Unknown or disabled agent type: "does-not-exist"');
      expect(new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID)).list()).toEqual([]);
    } finally {
      await lifecycle.get("session_shutdown")?.();
      hermetic.restore();
    }
  });
});

describe("agent tool → schedule restrictions", () => {
  async function scheduleCall(
    params: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ): Promise<{ reply: string; jobCount: number; restore: () => void }> {
    const hermetic = hermeticDir(settings ? { settings, agentFiles: AGENT_FILES } : { agentFiles: AGENT_FILES });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const c = bootedCtx();
    await lifecycle.get("session_start")?.({}, c);

    const reply = textOf(
      await tools.get("agent").execute(
        "tc-sched",
        {
          prompt: "do the thing",
          description: "nightly sweep",
          schedule: "0 3 * * * *",
          subagent_type: "general-purpose",
          ...params,
        },
        undefined,
        undefined,
        c,
      ),
    );

    let jobCount = 0;
    try {
      jobCount = new ScheduleStore(resolveStorePath(c.cwd, SESSION_ID)).list().length;
    } catch {}
    await lifecycle.get("session_shutdown")?.();
    return { reply, jobCount, restore: hermetic.restore };
  }

  it("refuses `schedule` with `resume` — schedules create fresh agents", async () => {
    const { reply, jobCount, restore } = await scheduleCall({ resume: "agent-123" });
    try {
      expect(reply).toBe("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });

  it("refuses `schedule` with `inherit_context` — no parent conversation at fire time", async () => {
    const { reply, jobCount, restore } = await scheduleCall({ inherit_context: true });
    try {
      expect(reply).toBe(
        "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });

  it("refuses `schedule` with `run_in_background: false` rather than silently coercing it", async () => {
    const { reply, jobCount, restore } = await scheduleCall({ run_in_background: false });
    try {
      expect(reply).toBe(
        "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });

  it("accepts `run_in_background: true` and an omitted `run_in_background`", async () => {
    for (const params of [{ run_in_background: true }, {}]) {
      const { reply, jobCount, restore } = await scheduleCall(params);
      try {
        expect(reply).toContain("Scheduled");
        expect(jobCount).toBe(1);
      } finally {
        restore();
      }
    }
  });

  it("refuses scheduling entirely when the project disabled it", async () => {
    const { reply, jobCount, restore } = await scheduleCall({}, { schedulingEnabled: false });
    try {
      expect(reply).toBe(
        "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.",
      );
      expect(jobCount).toBe(0);
    } finally {
      restore();
    }
  });
});
