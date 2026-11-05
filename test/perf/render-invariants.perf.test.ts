import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — cost stays linear in transcript length", () => {
  function wrapsFor(n: number, mode: string): number {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => mode);
    viewer.render(120);
    counts.wrap = 0;
    counts.markdownRender = 0;
    viewer.render(120);
    return counts.wrap + counts.markdownRender;
  }

  it("does ~10x the work for 10x the messages (raw wrap path)", () => {
    const small = wrapsFor(30, "off");
    const large = wrapsFor(300, "off");

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
  });

  it("does ~10x the work for 10x the messages (markdown path)", () => {
    const small = wrapsFor(30, "assistant");
    const large = wrapsFor(300, "assistant");

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
  });

  it("re-renders without re-parsing: the markdown cache survives a frame", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(60), undefined, () => "assistant");
    viewer.render(120);
    const afterFirst = counts.markdownNew;
    expect(afterFirst).toBeGreaterThan(0);

    viewer.render(120);
    viewer.render(120);

    expect(counts.markdownNew).toBe(afterFirst);
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget({ ...manager, getActivity: (id: string) => makeActivity(records).get(id) }, () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render();
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
