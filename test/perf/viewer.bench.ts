import { bench, describe } from "vitest";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { makeSession, mountViewer } from "../helpers/perf-fixtures.js";

const SIZES = [50, 500, 5000];

describe("ConversationViewer.render — markdown: assistant (default)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n));
    viewer.render(120);
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — markdown: off (raw wrap)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => "off");
    viewer.render(120);
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — cold cache (first frame)", () => {
  const WARMUP = 2;
  const SAMPLES = { 50: 40, 500: 12 } as Record<number, number>;

  for (const n of [50, 500]) {
    const iterations = SAMPLES[n];
    const pool = Array.from({ length: iterations + WARMUP }, () =>
      mountViewer(ConversationViewer, makeSession(n)),
    );
    let next = 0;
    bench(
      `${n} messages`,
      () => {
        pool[next++ % pool.length].render(120);
      },
      { time: 0, iterations, warmupTime: 0, warmupIterations: WARMUP },
    );
  }
});
