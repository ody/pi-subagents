/**
 * widget-layout.ts — Pure layout of the agent widget body: fit-or-overflow
 * selection and tree-connector fix-up. Heading and "+N more" footer belong to
 * the caller.
 */

export interface WidgetSections {
  /** One line per finished agent. */
  finished: string[];
  /** One [header, activity] pair per running agent. */
  running: [string, string][];
  /** Single summary line for all queued agents. */
  queued?: string;
}

export interface WidgetLayout {
  body: string[];
  /** Present only when the body overflowed: agents that got no row. */
  hidden?: { running: number; finished: number };
}

/**
 * Lay out body lines within `maxBody` lines, with a line reserved for the
 * caller's overflow footer when anything is hidden. Priority on overflow:
 * running > queued > finished.
 */
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

  // Reserve 1 line for the overflow indicator.
  let budget = maxBody - 1;
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  const body: string[] = [];

  // Reserve the queued line's row up front. It is a single summary of N
  // waiting agents, so it cannot be folded into the "+N more" count (which
  // is denominated in agents) without either under-reporting it as 1 or
  // inflating the total with agents that were never getting their own rows.
  // Reserving costs at most one running agent — which IS counted below —
  // and makes the drop unreachable. It matters most exactly when it used to
  // vanish: the pool is saturated and the queue is what the user needs to see.
  const queuedReserve = queued ? 1 : 0;
  budget -= queuedReserve;

  // 1. Running agents (2 lines each)
  for (const pair of running) {
    if (budget >= 2) {
      body.push(...pair);
      budget -= 2;
    } else {
      hiddenRunning++;
    }
  }

  // 2. Queued line (always fits — its row was reserved above)
  if (queued) {
    budget += queuedReserve;
    body.push(queued);
    budget--;
  }

  // 3. Finished agents
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

/**
 * Swap ├─ → └─ on the last line. When the body ends with a running agent's
 * header + activity pair, also close the header and blank the activity's │.
 */
function closeLastConnector(body: string[], endsWithRunningPair: boolean): void {
  if (body.length === 0) return;
  const last = body.length - 1;
  body[last] = body[last].replace("├─", "└─");
  if (endsWithRunningPair && body.length >= 2) {
    body[last - 1] = body[last - 1].replace("├─", "└─");
    body[last] = body[last].replace("│  ", "   ");
  }
}
