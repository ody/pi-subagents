import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentRecord } from "../types.js";

export function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

export function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId">,
): boolean {
  return record.parentAgentId === undefined;
}

export function occupiesForegroundSlot(
  record: Pick<AgentRecord, "blocking" | "parentAgentId">,
): boolean {
  return !!record.blocking && isTopLevelAgent(record);
}

export type Pool = "background" | "foreground";
