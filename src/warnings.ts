export type WarningSink = (message: string) => void;

let sink: WarningSink | undefined;
let pending: string[] = [];

export function warn(message: string): void {
  if (sink) sink(message);
  else pending.push(message);
}

export function setWarningSink(next: WarningSink | undefined): void {
  sink = next;
  const queued = pending;
  pending = [];
  if (next) for (const message of queued) next(message);
}
