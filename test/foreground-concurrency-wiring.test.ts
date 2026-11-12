import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/session/agent-runner.js")>("../src/session/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { runAgent } from "../src/session/agent-runner.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, maxConcurrentForeground: 1, ...settings },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation(
    (_c: any, _t: any, prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.onSessionCreated?.({
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
        });
        resolvers.set(prompt as string, () => resolve({
          responseText: `${prompt}-RESULT`,
          session: { dispose: vi.fn() },
          aborted: false,
          steered: false,
        }));
      }) as any,
  );
  return resolvers;
}

function callForeground(tools: Map<string, any>, prompt: string, opts: {
  signal?: AbortSignal;
  onUpdate?: (u: any) => void;
} = {}) {
  return tools.get("agent").execute(
    `tc-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: false },
    opts.signal,
    opts.onUpdate,
    ctx(),
  );
}

describe("maxConcurrentForeground, through the agent tool", () => {
  it("runs blocking calls one at a time and returns each its own result", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const first = callForeground(tools, "alpha");
    const second = callForeground(tools, "beta");
    await flush();

      expect(runAgent).toHaveBeenCalledTimes(1);

    resolvers.get("alpha")!();
    expect(textOf(await first)).toContain("alpha-RESULT");

    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    resolvers.get("beta")!();
    expect(textOf(await second)).toContain("beta-RESULT");
  });

  it("resolves a queued call as STOPPED when the turn is interrupted", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const controller = new AbortController();
    const first = callForeground(tools, "alpha");
    const second = callForeground(tools, "beta", { signal: controller.signal });
    await flush();

    controller.abort();

    const result = await second;
    expect(textOf(result)).toContain("STOPPED BY THE USER");
    expect(result.isError).toBeFalsy();

    resolvers.get("alpha")!();
    await first;
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("says it is queued in the live tool result, then stops saying it", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const firstUpdates: any[] = [];
    const secondUpdates: any[] = [];
    const first = callForeground(tools, "alpha", { onUpdate: u => firstUpdates.push(u) });
    const second = callForeground(tools, "beta", { onUpdate: u => secondUpdates.push(u) });
    await flush();

    const queuedActivity = secondUpdates.map(u => u.details?.activity);
    expect(queuedActivity.some((a: string) => a?.includes("waiting for a foreground slot"))).toBe(true);
    expect(secondUpdates.at(-1)?.details?.status).toBe("running");
    expect(firstUpdates.every((u: any) => !u.details?.activity?.includes("queued"))).toBe(true);

    resolvers.get("alpha")!();
    await first;
    await flush();

    const afterStart = secondUpdates.at(-1)?.details?.activity;
    expect(afterStart).not.toContain("waiting for a foreground slot");

    resolvers.get("beta")!();
    await second;
  });

  it("leaves blocking calls unbounded when the setting is unset", async () => {
    const { tools } = boot({ maxConcurrentForeground: 0 });
    const resolvers = controllableRuns();

    const calls = ["a", "b", "c"].map(p => callForeground(tools, p));
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const p of ["a", "b", "c"]) resolvers.get(p)!();
    await Promise.all(calls);
  });
});
