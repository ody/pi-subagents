import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScheduledSubagent, ScheduleStoreData } from "../types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { }
}

export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data: ScheduleStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.jobs.clear();
      for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
    } catch { }
  }

  private save(): void {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      this.jobs.set(job.id, job);
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    if (!this.jobs.has(id)) return undefined;
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      this.jobs.set(id, updated);
      return updated;
    });
  }

  remove(id: string): boolean {
    if (!this.jobs.has(id)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { }
    }
  }
}
