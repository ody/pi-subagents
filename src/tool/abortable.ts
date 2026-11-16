import type { AgentRecord } from "../types.js";

export async function waitForRunEnd(
  record: Pick<AgentRecord, "status" | "promise">,
  signal: AbortSignal | undefined,
  pollMs: number,
): Promise<void> {
  if (record.status !== "queued" && record.status !== "running") return;
  while (record.status === "queued") {
    await abortable(new Promise<void>(resolve => setTimeout(resolve, pollMs)), signal);
  }
  if (record.promise) await abortable(record.promise, signal);
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
