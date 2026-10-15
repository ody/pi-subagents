import { describe, expect, it } from "vitest";
import { buildNotificationDetails, formatTaskNotification, getStatusLabel } from "../src/notification-format.js";
import type { AgentActivity, AgentRecord } from "../src/types.js";

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "audit",
    status: "completed",
    toolUses: 2,
    startedAt: 1_000,
    completedAt: 4_000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return { activeTools: new Map(), toolUses: 2, responseText: "", turnCount: 1, ...over };
}

describe("getStatusLabel", () => {
  it("names the error and its message", () => {
    expect(getStatusLabel("error", "boom")).toBe("Error: boom");
  });

  it("falls back to unknown for a message-less error", () => {
    expect(getStatusLabel("error")).toBe("Error: unknown");
  });

  it("distinguishes aborted, steered and stopped", () => {
    expect(getStatusLabel("aborted")).toBe("Aborted (max turns exceeded)");
    expect(getStatusLabel("steered")).toBe("Wrapped up (turn limit)");
    expect(getStatusLabel("stopped")).toBe("Stopped");
  });

  it("defaults to Done", () => {
    expect(getStatusLabel("completed")).toBe("Done");
  });
});

describe("formatTaskNotification", () => {
  it("emits the task-notification XML shape", () => {
    const xml = formatTaskNotification(rec({ result: "ok" }), 500);
    expect(xml).toBe([
      `<task-notification>`,
      `<task-id>a1</task-id>`,
      `<status>Done</status>`,
      `<summary>Agent "audit" completed</summary>`,
      `<result>ok</result>`,
      `<usage><total_tokens>0</total_tokens><tool_uses>2</tool_uses><duration_ms>3000</duration_ms></usage>`,
      `</task-notification>`,
    ].join("\n"));
  });

  it("includes tool-use-id and output-file only when set", () => {
    const xml = formatTaskNotification(rec({ toolCallId: "tc1", outputFile: "/tmp/out.md" }), 500);
    expect(xml).toContain(`<tool-use-id>tc1</tool-use-id>`);
    expect(xml).toContain(`<output-file>/tmp/out.md</output-file>`);
    expect(formatTaskNotification(rec(), 500)).not.toContain("tool-use-id");
    expect(formatTaskNotification(rec(), 500)).not.toContain("output-file");
  });

  it("gates estimated_cost_usd on showCost", () => {
    const record = rec({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0.5 } });
    expect(formatTaskNotification(record, 500)).not.toContain("estimated_cost_usd");
    expect(formatTaskNotification(record, 500, true)).toContain(`<estimated_cost_usd>0.5000</estimated_cost_usd>`);
  });

  it("omits estimated_cost_usd even under showCost when nothing was charged", () => {
    expect(formatTaskNotification(rec({ lifetimeUsage: { input: 1, output: 1, cacheWrite: 1 } }), 500, true)).not.toContain("estimated_cost_usd");
  });

  it("appends the truncation note to an over-long result", () => {
    const xml = formatTaskNotification(rec({ result: "x".repeat(30) }), 10);
    expect(xml).toContain(`<result>xxxxxxxxxx\n...(truncated, use get_subagent_result for full output)</result>`);
    expect(xml).not.toContain("xxxxxxxxxx\nxxx");
  });

  it("leaves a short result alone and reports No output. when absent", () => {
    expect(formatTaskNotification(rec({ result: "ok" }), 500)).toContain(`<result>ok</result>`);
    expect(formatTaskNotification(rec(), 500)).toContain(`<result>No output.</result>`);
    expect(formatTaskNotification(rec({ result: "ok" }), 500)).not.toContain("truncated");
  });
});

describe("buildNotificationDetails", () => {
  it("truncates the result preview with an ellipsis", () => {
    const d = buildNotificationDetails(rec({ result: "y".repeat(30) }), 10);
    expect(d.resultPreview).toBe("y".repeat(10) + "…");
  });

  it("keeps a short result and reports No output. when absent", () => {
    expect(buildNotificationDetails(rec({ result: "ok" }), 10).resultPreview).toBe("ok");
    expect(buildNotificationDetails(rec(), 10).resultPreview).toBe("No output.");
  });

  it("carries cost and turn state unconditionally", () => {
    const record = rec({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0.42 } });
    const d = buildNotificationDetails(record, 10, activity({ turnCount: 3, maxTurns: 5 }));
    expect(d.totalCost).toBe(0.42);
    expect(d.turnCount).toBe(3);
    expect(d.maxTurns).toBe(5);
    expect(buildNotificationDetails(record, 10).turnCount).toBe(0);
  });
});
