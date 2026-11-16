import type { AgentRecord, StopCause } from "../types.js";

type Abort = (id: string, cause: StopCause) => boolean;

export function assertSignalCause(action: "spawn" | "resume", signal: AbortSignal | undefined, cause: StopCause | undefined): void {
  if (signal && !cause) {
    throw new Error(`A ${action} with a signal needs signalCause, the stop cause of the signal's owner.`);
  }
}

export function armQueuedAbort(abort: Abort, id: string, signal: AbortSignal | undefined, cause: StopCause | undefined): boolean {
  if (signal === undefined || cause === undefined) return true;
  if (signal.aborted) {
    abort(id, cause);
    return false;
  }
  signal.addEventListener("abort", () => abort(id, cause), { once: true });
  return true;
}

export function watchParentSignal(
  abort: Abort,
  record: AgentRecord,
  controller: AbortController,
  parentSignal: AbortSignal | undefined,
  cause: StopCause | undefined,
): (() => void) | undefined {
  if (!parentSignal || !cause) return undefined;
  const onParentAbort = () => {
    if (record.abortController === controller) abort(record.id, cause);
  };
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", onParentAbort);
}
