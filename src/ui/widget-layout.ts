export interface WidgetSections {
  finished: string[];
  running: [string, string][];
  queued?: string;
}

export interface WidgetLayout {
  body: string[];
  hidden?: { running: number; finished: number };
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

  let budget = maxBody - 1;
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  const body: string[] = [];

  const queuedReserve = queued ? 1 : 0;
  budget -= queuedReserve;

  for (const pair of running) {
    if (budget >= 2) {
      body.push(...pair);
      budget -= 2;
    } else {
      hiddenRunning++;
    }
  }

  if (queued) {
    budget += queuedReserve;
    body.push(queued);
    budget--;
  }

  for (const line of finished) {
    if (budget >= 1) {
      body.push(line);
      budget--;
    } else {
      hiddenFinished++;
    }
  }

  return { body, hidden: { running: hiddenRunning, finished: hiddenFinished } };
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
