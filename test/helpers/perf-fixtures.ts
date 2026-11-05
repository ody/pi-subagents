export const perfTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

export const NOW = Date.now();

export function perfTui(columns = 120, rows = 40) {
  return { terminal: { columns, rows }, requestRender: () => {} } as any;
}

export function perfSession(messages: unknown[] = []) {
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({
      tokens: { input: 12_000, output: 3_000, cacheWrite: 500 },
      contextUsage: { percent: 42 },
    }),
  } as any;
}

export interface FleetOptions {
  running?: number;
  queued?: number;
  finished?: number;
}

export function makeRecord(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `perf-agent-${i}`,
    type: i % 3 === 0 ? "Explore" : "general-purpose",
    description: `agent ${i} inspecting a subsystem for the benchmark fixture`,
    status: "running",
    toolUses: i % 7,
    startedAt: NOW - 1000 - (i % 5) * 100,
    completedAt: undefined as number | undefined,
    lifetimeUsage: { input: 1000 + i * 37, output: 200 + i * 11, cacheRead: 0, cacheWrite: 0 },
    compactionCount: i % 3,
    invocation: {
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      runInBackground: true,
    },
    isBackground: true,
    session: perfSession(),
    ...overrides,
  };
}

export function makeFleet(opts: FleetOptions = {}): ReturnType<typeof makeRecord>[] {
  const { running = 3, queued = 0, finished = 0 } = opts;
  const out: ReturnType<typeof makeRecord>[] = [];
  let i = 0;
  for (let n = 0; n < running; n++) out.push(makeRecord(i++));
  for (let n = 0; n < queued; n++) out.push(makeRecord(i++, { status: "queued" }));
  for (let n = 0; n < finished; n++) out.push(makeRecord(i++, { status: "completed", completedAt: NOW }));
  return out;
}

export function makeActivity(records: { id: string; toolUses: number }[]): Map<string, any> {
  return new Map(
    records.map(r => [
      r.id,
      {
        activeTools: new Map(),
        toolUses: r.toolUses,
        responseText: "working on the fixture",
        turnCount: 2,
        session: perfSession(),
      },
    ]),
  );
}

export function makeManager(records: unknown[], activity?: Map<string, unknown>) {
  return {
    listAgents: () => records,
    getActivity: (id: string) => activity?.get(id),
    listTombstones: () => [],
    getRecord: (id: string) => records.find(r => (r as { id: string }).id === id),
    getMaxConcurrent: () => 4,
  } as any;
}

const PARAGRAPH =
  "The subagent inspected the module and found that the render path rebuilds " +
  "its content on every frame, which is fine for a short transcript and not " +
  "fine for a long one. Here is what it looked like in practice, at width 120.";

const ASSISTANT_MARKDOWN =
  `## Findings\n\n${PARAGRAPH}\n\n- the first observation, which wraps\n` +
  "- the second observation\n\n```ts\nconst x = compute(input);\n```\n";

const TOOL_RESULT = `${PARAGRAPH}\n${PARAGRAPH}\n`;

export function makeSession(n: number) {
  const messages: any[] = [];
  for (let i = 0; i < n; i++) {
    const slot = i % 3;
    if (slot === 0) {
      messages.push({ role: "user", content: `Message ${i}: ${PARAGRAPH}` });
    } else if (slot === 1) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `${ASSISTANT_MARKDOWN}\n(message ${i})` },
          { type: "toolCall", name: "read" },
        ],
      });
    } else {
      messages.push({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: `${TOOL_RESULT}(result ${i})` }],
      });
    }
  }
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

export function mountWidget(
  Widget: any,
  records: unknown[],
  opts: { mode?: string; showCost?: boolean; showModel?: boolean } = {},
) {
  const widget = new Widget(
    makeManager(records, makeActivity(records as { id: string; toolUses: number }[])),
    () => opts.mode ?? "all",
    () => opts.showCost ?? false,
    () => opts.showModel ?? false,
  );
  let factory: any;
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key: string, content: any) => { factory = content; },
  });
  widget.update();
  const tui = perfTui();
  factory?.(tui, perfTheme).render();
  return {
    widget,
    render: (): string[] => (factory ? factory(tui, perfTheme).render() : []),
    update: () => widget.update(),
    dispose: () => widget.dispose?.(),
  };
}

export function mountFleet(FleetList: any, records: unknown[]) {
  const fleet = new FleetList(makeManager(records, makeActivity(records as { id: string; toolUses: number }[])));
  let factory: any;
  fleet.setUICtx({
    setWidget: (_key: string, content: any) => { factory = content; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise(() => {}),
  });
  fleet.update();
  const tui = perfTui();
  factory?.(tui, perfTheme).render(120);
  return {
    fleet,
    render: (width = 120): string[] => (factory ? factory(tui, perfTheme).render(width) : []),
    update: () => fleet.update(),
    dispose: () => fleet.dispose?.(),
  };
}

export function mountViewer(
  Viewer: any,
  session: any,
  record: unknown = makeRecord(0),
  markdownMode?: () => string,
) {
  const viewer = new Viewer(
    perfTui(120, 40),
    session,
    record,
    undefined,
    perfTheme,
    () => {},
    undefined,
    undefined,
    undefined,
    false,
    markdownMode,
  );
  return viewer;
}
