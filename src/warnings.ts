export type WarningSink = (message: string) => void;

let sink: WarningSink | undefined;
let pending: string[] = [];
const warnedKeys = new Set<string>();

export function warn(message: string): void {
  if (sink) sink(message);
  else pending.push(message);
}

export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  warn(message);
}

export function forgetWarning(key: string): void {
  warnedKeys.delete(key);
}

export function resetWarnings(): void {
  warnedKeys.clear();
  pending = [];
  sink = undefined;
}

export function setWarningSink(next: WarningSink | undefined): void {
  sink = next;
  const queued = pending;
  pending = [];
  if (next) for (const message of queued) next(message);
}
