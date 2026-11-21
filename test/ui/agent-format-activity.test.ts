import { describe, expect, it } from "vitest";
import { buildInvocationTags, describeActivity } from "../../src/ui/agent-format.js";

describe("buildInvocationTags", () => {
  it("returns no tags without an invocation", () => {
    expect(buildInvocationTags(undefined)).toEqual({ tags: [] });
  });

  it("lists plain flags in a fixed order", () => {
    expect(buildInvocationTags({ thinking: "high", isolated: true, isolation: "worktree", inheritContext: true, runInBackground: true, maxTurns: 5 }).tags)
      .toEqual(["thinking: high", "isolated", "worktree", "inherit context", "background", "max turns: 5"]);
  });

  it("notes a thinking level that differs from the request or the pin", () => {
    expect(buildInvocationTags({ thinking: "low", requestedThinking: "high", pinnedThinking: "medium" }).tags)
      .toEqual(["thinking: low (asked high, over medium)"]);
    expect(buildInvocationTags({ thinking: "low", requestedThinking: "low", pinnedThinking: "low" }).tags).toEqual(["thinking: low"]);
  });

  it("shows a background choice that overrides the pin, in both directions", () => {
    expect(buildInvocationTags({ runInBackground: true, pinnedRunInBackground: false }).tags).toEqual(["background (over foreground)"]);
    expect(buildInvocationTags({ runInBackground: false, pinnedRunInBackground: true }).tags).toEqual(["foreground (over background)"]);
    expect(buildInvocationTags({ runInBackground: true, pinnedRunInBackground: true }).tags).toEqual(["background"]);
    expect(buildInvocationTags({ pinnedRunInBackground: false }).tags).toEqual([]);
  });

  it("shows a turn limit that overrides the pin, including unlimited", () => {
    expect(buildInvocationTags({ maxTurns: 3, pinnedMaxTurns: 8 }).tags).toEqual(["3 turns (over 8)"]);
    expect(buildInvocationTags({ pinnedMaxTurns: 8 }).tags).toEqual(["unlimited (over 8)"]);
    expect(buildInvocationTags({ maxTurns: 3, pinnedMaxTurns: 0 }).tags).toEqual(["3 turns (over unlimited)"]);
    expect(buildInvocationTags({ maxTurns: 8, pinnedMaxTurns: 8 }).tags).toEqual(["max turns: 8"]);
    expect(buildInvocationTags({ pinnedMaxTurns: 0 }).tags).toEqual([]);
  });

  it("marks a model that differs from the pinned model", () => {
    expect(buildInvocationTags({ modelName: "opus", modelId: "a/opus", pinnedModel: "a/sonnet" }))
      .toEqual({ modelName: "opus (over pinned a/sonnet)", modelId: "a/opus (over pinned a/sonnet)", tags: [] });
    expect(buildInvocationTags({ modelName: "a/opus", modelId: "a/opus", pinnedModel: "a/opus" }))
      .toEqual({ modelName: "a/opus", modelId: "a/opus", tags: [] });
  });
});

describe("describeActivity", () => {
  it("groups active tools by action and counts repeats", () => {
    const tools = new Map([["1", "read"], ["2", "read"], ["3", "grep"], ["4", "grep"], ["5", "bash"], ["6", "custom"]]);
    expect(describeActivity(tools)).toBe("reading 2 files, searching 2 patterns, running command, custom…");
  });

  it("falls back to the first non-blank response line, truncated", () => {
    expect(describeActivity(new Map(), "\n  hello world  \nnext")).toBe("hello world");
    expect(describeActivity(new Map(), "x".repeat(80))).toBe(`${"x".repeat(60)}…`);
  });

  it("reports thinking when nothing is active and no text exists", () => {
    expect(describeActivity(new Map())).toBe("thinking…");
    expect(describeActivity(new Map(), "   ")).toBe("thinking…");
  });
});
