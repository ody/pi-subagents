import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../src/types.js";
import { formatCost, formatTokens } from "../src/ui/agent-format.js";
import { formatBatchSummary, formatNotification, notificationStats } from "../src/ui/notification-block.js";

const theme = {
  fg: (c: string, s: string) => `<${c}:${s}>`,
  bold: (s: string) => `*${s}*`,
};

function det(over: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "a1", description: "audit", status: "completed", toolUses: 0, turnCount: 0,
    totalTokens: 0, durationMs: 0, resultPreview: "done", ...over,
  };
}

describe("notificationStats", () => {
  it("is empty when nothing is nonzero", () => {
    expect(notificationStats(det(), true, theme)).toBe("");
  });

  it("joins parts with a dim dot", () => {
    expect(notificationStats(det({ turnCount: 2, durationMs: 1000 }), true, theme)).toBe(
      "<dim:↻2> <dim:·> <dim:1.0s>",
    );
  });

  it("includes max turns and singular tool use", () => {
    expect(notificationStats(det({ turnCount: 2, maxTurns: 4, toolUses: 1 }), true, theme)).toBe(
      "<dim:↻2≤4> <dim:·> <dim:1 tool use>",
    );
  });

  it("includes cost only when showCost and nonzero", () => {
    const d = det({ totalCost: 0.05 });
    expect(notificationStats(d, true, theme)).toBe(`<dim:${formatCost(0.05)}>`);
    expect(notificationStats(d, false, theme)).toBe("");
    expect(notificationStats(det({ totalCost: 0 }), true, theme)).toBe("");
  });

  it("includes tokens", () => {
    expect(notificationStats(det({ totalTokens: 1500 }), true, theme)).toBe(`<dim:${formatTokens(1500)}>`);
  });
});

describe("formatNotification", () => {
  const opts = { expanded: false, showCost: true };

  it("renders header and collapsed preview", () => {
    expect(formatNotification(det(), opts, theme)).toBe(
      "<success:✓> *audit* <dim:completed>\n  <dim:⎿  done>",
    );
  });

  it("marks failures and steering", () => {
    expect(formatNotification(det({ status: "aborted" }), opts, theme)).toContain("<error:✗> *audit* <dim:aborted>");
    expect(formatNotification(det({ status: "steered" }), opts, theme)).toContain("<dim:completed (steered)>");
  });

  it("puts the stats line under the header", () => {
    expect(formatNotification(det({ toolUses: 2 }), opts, theme).split("\n")[1]).toBe("  <dim:2 tool uses>");
  });

  it("expands to 30 lines", () => {
    const preview = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    const rows = formatNotification(det({ resultPreview: preview }), { ...opts, expanded: true }, theme).split("\n");
    expect(rows).toHaveLength(31);
    expect(rows[30]).toBe("<dim:  l29>");
  });

  it("cuts the collapsed preview at 80 chars", () => {
    expect(formatNotification(det({ resultPreview: "y".repeat(90) }), opts, theme)).toContain(
      `<dim:⎿  ${"y".repeat(80)}>`,
    );
  });

  it("appends the transcript path", () => {
    expect(formatNotification(det({ outputFile: "/t" }), opts, theme).endsWith("\n  <muted:transcript: /t>")).toBe(true);
  });
});

describe("formatBatchSummary", () => {
  it("sums tokens and cost across agents", () => {
    const all = [det({ totalCost: 0.5, totalTokens: 1000 }), det({ totalCost: 0.25, totalTokens: 1000 })];
    expect(formatBatchSummary(all, theme)).toBe(`<dim:2 agents · ${formatTokens(2000)} · ${formatCost(0.75)}>`);
  });

  it("is undefined when the total cost is zero", () => {
    expect(formatBatchSummary([det(), det()], theme)).toBeUndefined();
  });
});
