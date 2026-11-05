import { describe, expect, it } from "vitest";
import { layoutWidgetBody } from "../src/ui/widget-layout.js";

const run = (n: number): [string, string] => [`├─ run${n}`, `│    ⎿ act${n}`];

describe("layoutWidgetBody", () => {
  it("returns an empty body for no sections", () => {
    expect(layoutWidgetBody({ finished: [], running: [] }, 11)).toEqual({ body: [] });
  });

  it("orders finished, running, queued and closes the last line", () => {
    const { body, hidden } = layoutWidgetBody(
      { finished: ["├─ fin"], running: [run(1)], queued: "├─ ◦ 2 queued" },
      11,
    );
    expect(hidden).toBeUndefined();
    expect(body).toEqual(["├─ fin", "├─ run1", "│    ⎿ act1", "└─ ◦ 2 queued"]);
  });

  it("closes a last running pair: header └─, activity │ replaced", () => {
    const { body } = layoutWidgetBody({ finished: ["├─ fin"], running: [run(1), run(2)] }, 11);
    expect(body).toEqual(["├─ fin", "├─ run1", "│    ⎿ act1", "└─ run2", "     ⎿ act2"]);
  });

  it("closes a last finished line", () => {
    expect(layoutWidgetBody({ finished: ["├─ a", "├─ b"], running: [] }, 11).body).toEqual(["├─ a", "└─ b"]);
  });

  it("overflows by dropping finished first, reserving the queued row", () => {
    const { body, hidden } = layoutWidgetBody(
      { finished: ["├─ f1", "├─ f2"], running: [run(1), run(2)], queued: "├─ q" },
      6,
    );
    expect(body).toEqual(["├─ run1", "│    ⎿ act1", "├─ run2", "│    ⎿ act2", "├─ q"]);
    expect(hidden).toEqual({ running: 0, finished: 2 });
  });

  it("hides running agents that do not fit, queued row still shown", () => {
    const { body, hidden } = layoutWidgetBody(
      { finished: ["├─ f"], running: [run(1), run(2), run(3)], queued: "├─ q" },
      6,
    );
    expect(body).toEqual(["├─ run1", "│    ⎿ act1", "├─ run2", "│    ⎿ act2", "├─ q"]);
    expect(hidden).toEqual({ running: 1, finished: 1 });
  });
});
