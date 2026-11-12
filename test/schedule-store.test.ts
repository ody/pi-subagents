import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStorePath, ScheduleStore } from "../src/triggers/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

function makeJob(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: "job-" + Math.random().toString(36).slice(2, 10),
    name: "test-job",
    description: "test",
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 5 * 60_000,
    subagent_type: "general-purpose",
    prompt: "hello",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("ScheduleStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-store-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolveStorePath produces session-scoped path under .pi/subagent-schedules/", () => {
    const p = resolveStorePath("/repo", "abc123");
    expect(p).toBe("/repo/.pi/subagent-schedules/abc123.json");
  });

  it("starts empty and round-trips a job through add/list", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    expect(store.list()).toEqual([]);
    const job = makeJob();
    store.add(job);
    expect(store.list()).toEqual([job]);

    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()).toEqual([job]);
  });

  it("update returns merged record and persists the patch", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "before" });
    store.add(job);

    const updated = store.update(job.id, { name: "after", runCount: 3 });
    expect(updated).toMatchObject({ id: job.id, name: "after", runCount: 3 });

    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()[0]).toMatchObject({ name: "after", runCount: 3 });
  });

  it("update returns undefined for unknown id and does not create a record", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const r = store.update("nonexistent", { name: "x" });
    expect(r).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("remove returns true on existing job and false on missing", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob();
    store.add(job);
    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(job.id)).toBe(false);
  });

  it("hasName excludes a given id (for rename safety)", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "alpha" });
    store.add(job);
    expect(store.hasName("alpha")).toBe(true);
    expect(store.hasName("alpha", job.id)).toBe(false);
    expect(store.hasName("beta")).toBe(false);
  });

  it("uses atomic temp+rename — write produces final file, no .tmp leftover", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    store.add(makeJob());
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("keeps a legacy job unversioned and a version 2 job marked, in one file", () => {
    const file = join(tmp, "mixed.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [makeJob({ id: "old", thinking: "high", max_turns: 3 })] }));
    const store = new ScheduleStore(file);
    store.add(makeJob({ id: "new", version: 2, thinking: "low", max_turns: 0 }));

    const reloaded = new ScheduleStore(file);
    expect(reloaded.get("old")?.version).toBeUndefined();
    expect(reloaded.get("old")?.max_turns).toBe(3);
    expect(reloaded.get("new")).toMatchObject({ version: 2, thinking: "low", max_turns: 0 });
  });

  it("self-heals from a corrupt JSON file — load silently empties, next save rewrites", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, "{ this is not valid JSON");
    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);

    store.add(makeJob({ id: "fresh" }));
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.version).toBe(2);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe("fresh");
  });

  it("recovers from a stale lock left by a dead process", () => {
    const file = join(tmp, "s.json");
    const lockFile = file + ".lock";
    writeFileSync(lockFile, "999999999");

    const store = new ScheduleStore(file);
    expect(() => store.add(makeJob())).not.toThrow();
    expect(store.list()).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases the lock after a successful mutation so subsequent ones don't deadlock", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const a = makeJob({ id: "a" });
    const b = makeJob({ id: "b" });
    store.add(a);
    store.add(b);
    expect(store.list().map(j => j.id).sort()).toEqual(["a", "b"]);
  });

  it("does not create the backing directory until a mutation persists", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");

    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);

    store.add(makeJob());
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("no-op update/remove of an unknown id never creates the backing directory", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");
    const store = new ScheduleStore(file);

    expect(store.update("nonexistent", { name: "x" })).toBeUndefined();
    expect(store.remove("nonexistent")).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("deleteFileIfEmpty unlinks file only when no jobs remain", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    const job = makeJob();
    store.add(job);
    store.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(true);

    store.remove(job.id);
    store.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(false);
  });
});
