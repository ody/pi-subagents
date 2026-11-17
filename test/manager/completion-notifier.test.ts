import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionNotifier } from "../../src/manager/completion-notifier.js";
import type { AgentRecord } from "../../src/types.js";

function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    completedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ...overrides,
  } as AgentRecord;
}

function makeNotifier(records: AgentRecord[]) {
  const byId = new Map(records.map(r => [r.id, r]));
  const sendMessage = vi.fn();
  const notifier = new CompletionNotifier({
    pi: { sendMessage },
    manager: { getActivity: () => undefined, getRecord: (id: string) => byId.get(id) },
    widget: { markFinished: vi.fn(), update: vi.fn() },
    fleet: { onAgentFinished: vi.fn() },
    settings: { showCost: false },
  } as unknown as ConstructorParameters<typeof CompletionNotifier>[0]);
  return { notifier, sendMessage };
}

describe("CompletionNotifier.isNotificationPending", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is false for an unknown agent", () => {
    const { notifier } = makeNotifier([]);
    expect(notifier.isNotificationPending("nobody")).toBe(false);
  });

  it("is true while the agent is in the batch window", () => {
    const { notifier } = makeNotifier([record("a")]);
    notifier.addToBatch("a", "async");

    expect(notifier.isNotificationPending("a")).toBe(true);
    expect(notifier.isNotificationPending("b")).toBe(false);
  });

  it("is true from the batch window through the scheduled nudge, then false", () => {
    const { notifier, sendMessage } = makeNotifier([record("a")]);
    notifier.addToBatch("a", "async");

    vi.advanceTimersByTime(100);
    expect(notifier.isNotificationPending("a")).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notifier.isNotificationPending("a")).toBe(false);
  });

  it("is true while an individual nudge is scheduled after completion", () => {
    const a = record("a");
    const { notifier, sendMessage } = makeNotifier([a]);

    notifier.onAgentComplete(a);
    expect(notifier.isNotificationPending("a")).toBe(true);

    vi.advanceTimersByTime(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notifier.isNotificationPending("a")).toBe(false);
  });

  it("is false once a cancelled nudge is cleared", () => {
    const a = record("a");
    const { notifier, sendMessage } = makeNotifier([a]);
    notifier.onAgentComplete(a);

    notifier.cancelNudge("a");

    expect(notifier.isNotificationPending("a")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is false after dispose", () => {
    const a = record("a");
    const { notifier } = makeNotifier([a]);
    notifier.onAgentComplete(a);

    notifier.dispose();

    expect(notifier.isNotificationPending("a")).toBe(false);
  });

  describe("group join", () => {
    function groupOf(a: AgentRecord, b: AgentRecord) {
      const made = makeNotifier([a, b]);
      made.notifier.addToBatch(a.id, "smart");
      made.notifier.addToBatch(b.id, "smart");
      vi.advanceTimersByTime(100);
      return made;
    }

    it("is true for every member while the join is open", () => {
      const a = record("a");
      const b = record("b", { status: "running", completedAt: undefined });
      const { notifier } = groupOf(a, b);

      notifier.onAgentComplete(a);

      expect(notifier.isNotificationPending("a")).toBe(true);
      expect(notifier.isNotificationPending("b")).toBe(true);
    });

    it("stays true for each member while the group nudge is scheduled, then false", () => {
      const a = record("a");
      const b = record("b", { status: "running", completedAt: undefined });
      const { notifier, sendMessage } = groupOf(a, b);
      notifier.onAgentComplete(a);

      b.status = "completed";
      b.completedAt = 2;
      notifier.onAgentComplete(b);

      expect(notifier.isNotificationPending("a")).toBe(true);
      expect(notifier.isNotificationPending("b")).toBe(true);

      vi.advanceTimersByTime(200);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(notifier.isNotificationPending("a")).toBe(false);
      expect(notifier.isNotificationPending("b")).toBe(false);
    });

    it("keeps a delivered partial member pending through its nudge, then clears it", () => {
      const a = record("a");
      const b = record("b", { status: "running", completedAt: undefined });
      const { notifier, sendMessage } = groupOf(a, b);
      notifier.onAgentComplete(a);

      vi.advanceTimersByTime(30_000);
      expect(notifier.isNotificationPending("a")).toBe(true);

      vi.advanceTimersByTime(200);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(notifier.isNotificationPending("a")).toBe(false);
      expect(notifier.isNotificationPending("b")).toBe(true);
    });
  });
});

describe("CompletionNotifier result hint", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sendGroup(a: AgentRecord, b: AgentRecord) {
    const made = makeNotifier([a, b]);
    made.notifier.addToBatch(a.id, "smart");
    made.notifier.addToBatch(b.id, "smart");
    vi.advanceTimersByTime(300);
    expect(made.sendMessage).toHaveBeenCalledTimes(1);
    return made.sendMessage.mock.calls[0][0].content as string;
  }

  it("names agent_get_result in a group message when a preview cut a result", () => {
    const content = sendGroup(record("a", { result: "x".repeat(301) }), record("b", { result: "short" }));
    expect(content).toContain("Use agent_get_result for full output.");
  });

  it("omits agent_get_result from a group message when no preview cut a result", () => {
    const content = sendGroup(record("a", { result: "x".repeat(300) }), record("b", { result: "short" }));
    expect(content).not.toContain("agent_get_result");
  });

  it("names agent_get_result in a single message only when the preview cut the result", () => {
    const cutRecord = record("a", { result: "x".repeat(501) });
    const wholeRecord = record("b", { result: "x".repeat(500) });
    const { notifier, sendMessage } = makeNotifier([cutRecord, wholeRecord]);
    notifier.onAgentComplete(cutRecord);
    notifier.onAgentComplete(wholeRecord);
    vi.advanceTimersByTime(200);

    const [cutMessage, wholeMessage] = sendMessage.mock.calls.map(c => c[0].content as string);
    expect(cutMessage).toContain("agent_get_result");
    expect(wholeMessage).not.toContain("agent_get_result");
  });
});

describe("CompletionNotifier and consumed results", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends nothing for a record consumed while its nudge was held", () => {
    const a = record("a");
    const { notifier, sendMessage } = makeNotifier([a]);
    notifier.onAgentComplete(a);

    a.resultConsumed = true;
    vi.advanceTimersByTime(200);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not consume a result when it sends the notification", () => {
    const a = record("a");
    const { notifier, sendMessage } = makeNotifier([a]);
    notifier.onAgentComplete(a);

    vi.advanceTimersByTime(200);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(a.resultConsumed).toBeFalsy();
  });
});
