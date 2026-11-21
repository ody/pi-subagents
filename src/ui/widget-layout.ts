export interface WidgetSections {
  finished: string[];
  running: [string, string][];
  queued?: string;
  pinned?: { section: "finished" | "running"; index: number };
}

export interface WidgetLayout {
  body: string[];
  hidden?: { running: number; finished: number };
}

function keepWithinBudget(
  { finished, running, queued, pinned }: WidgetSections,
  maxBody: number,
): { keptFinished: Set<number>; keptRunning: Set<number> } {
  let budget = maxBody - 1;
  const keptFinished = new Set<number>();
  const keptRunning = new Set<number>();

  if (pinned) {
    const cost = pinned.section === "running" ? 2 : 1;
    if (budget >= cost) {
      (pinned.section === "running" ? keptRunning : keptFinished).add(pinned.index);
      budget -= cost;
    }
  }

  budget -= queued ? 1 : 0;

  running.forEach((_pair, index) => {
    if (keptRunning.has(index) || budget < 2) return;
    keptRunning.add(index);
    budget -= 2;
  });
  finished.forEach((_line, index) => {
    if (keptFinished.has(index) || budget < 1) return;
    keptFinished.add(index);
    budget--;
  });
  return { keptFinished, keptRunning };
}

export function layoutWidgetBody(sections: WidgetSections, maxBody: number): WidgetLayout {
  const { finished, running, queued } = sections;
  const totalBody = finished.length + running.length * 2 + (queued ? 1 : 0);

  if (totalBody <= maxBody) {
    const body: string[] = [...finished];
    for (const pair of running) body.push(...pair);
    if (queued) body.push(queued);
    closeLastConnector(body, running.length > 0 && !queued);
    return { body };
  }

  const { keptFinished, keptRunning } = keepWithinBudget(sections, maxBody);
  const body: string[] = [];
  finished.forEach((line, index) => {
    if (keptFinished.has(index)) body.push(line);
  });
  running.forEach((pair, index) => {
    if (keptRunning.has(index)) body.push(...pair);
  });
  if (queued) body.push(queued);

  return { body, hidden: { running: running.length - keptRunning.size, finished: finished.length - keptFinished.size } };
}

function closeLastConnector(body: string[], endsWithRunningPair: boolean): void {
  if (body.length === 0) return;
  const last = body.length - 1;
  body[last] = body[last].replace("├─", "└─");
  if (endsWithRunningPair && body.length >= 2) {
    body[last - 1] = body[last - 1].replace("├─", "└─");
    body[last] = body[last].replace("│  ", "   ");
  }
}
