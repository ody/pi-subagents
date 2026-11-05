import { afterAll, bench, describe } from "vitest";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { FleetList } from "../../src/ui/fleet-list.js";
import { makeFleet, mountFleet, mountWidget } from "../helpers/perf-fixtures.js";

const SIZES = [1, 10, 100];

const mounted: { dispose: () => void }[] = [];
function track<T extends { dispose: () => void }>(m: T): T {
  mounted.push(m);
  return m;
}
afterAll(() => {
  for (const m of mounted) m.dispose();
});

describe("AgentWidget.render (per TUI frame)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.render();
    });
  }
});

describe("AgentWidget.update (80ms timer + ~10 call sites)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.update();
    });
  }
});

describe("AgentWidget.render — the widget's real mix", () => {
  const mix = () => makeFleet({ running: 3, queued: 7, finished: 3 });

  const off = track(mountWidget(AgentWidget, mix(), { mode: "background" }));
  bench("3 running / 7 queued / 3 finished — showModel off", () => {
    off.render();
  });

  const on = track(mountWidget(AgentWidget, mix(), { mode: "background", showModel: true }));
  bench("3 running / 7 queued / 3 finished — showModel on", () => {
    on.render();
  });

  const cost = track(mountWidget(AgentWidget, mix(), { mode: "background", showCost: true }));
  bench("3 running / 7 queued / 3 finished — showCost on", () => {
    cost.render();
  });
});

describe("FleetList.render (per TUI frame, below the editor)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.render(120);
    });
  }
});

describe("FleetList.update (200ms timer)", () => {
  for (const n of SIZES) {
    const f = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      f.update();
    });
  }
});
