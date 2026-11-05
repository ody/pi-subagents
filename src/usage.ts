import type { RuntimeSettings } from "./config/runtime-settings.js";

export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number };

export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

export function getLifetimeCost(u?: LifetimeUsage): number {
  return u?.cost ?? 0;
}

export function assistantUsage(message: { usage?: any }): LifetimeUsage | undefined {
  const u = message.usage;
  if (!u) return undefined;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cost: u.cost?.total ?? 0,
  };
}

export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
  if (delta.cost) into.cost = (into.cost ?? 0) + delta.cost;
}

export type ReportedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export function toReportedUsage(u: LifetimeUsage): ReportedUsage | undefined {
  const { input, output, cacheWrite, cacheRead = 0, cost = 0 } = u;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

export class PendingUsagePool {
  private pending: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  private dirty = false;

  add(delta: LifetimeUsage): void {
    addUsage(this.pending, delta);
    this.dirty = true;
  }

  drain(): ReportedUsage | undefined {
    if (!this.dirty) return undefined;
    const drained = toReportedUsage(this.pending);
    this.pending = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    this.dirty = false;
    return drained;
  }
}

export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}

export interface UsageReportingDeps {
  settings: Readonly<Pick<RuntimeSettings, "reportUsage">>;
  pendingUsage: Pick<PendingUsagePool, "drain">;
}

export function withUsageReporting<T extends { execute: (...args: any[]) => any }>(
  tool: T,
  { settings, pendingUsage }: UsageReportingDeps,
): T {
  return {
    ...tool,
    execute: async (toolCallId: string | undefined, ...rest: any[]) => {
      const result = await tool.execute(toolCallId, ...rest);
      if (!settings.reportUsage || !toolCallId) return result;
      const usage = pendingUsage.drain();
      return usage ? { ...result, usage } : result;
    },
  };
}
