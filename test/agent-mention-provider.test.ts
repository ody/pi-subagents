import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/manager/agent-manager.js";
import type { AgentRecord, AgentTombstone } from "../src/types.js";
import { createMentionProvider, mentionRoster } from "../src/ui/agent-mention.js";

const FILE_SUGGESTIONS = { items: [{ value: "@src/index.ts", label: "src/index.ts" }], prefix: "@src/" };

function builtIn() {
  return {
    triggerCharacters: ["@", "#"],
    getSuggestions: vi.fn().mockResolvedValue(FILE_SUGGESTIONS),
    applyCompletion: vi.fn().mockReturnValue({ lines: ["applied"], cursorLine: 0, cursorCol: 7 }),
    shouldTriggerFileCompletion: vi.fn().mockReturnValue(false),
  };
}

function record(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: `id-${over.handle}`,
    type: "Explore",
    description: "find flaky tests",
    status: "running",
    toolUses: 0,
    startedAt: 1000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function managerWith(...records: AgentRecord[]): AgentManager {
  // listAgents() is newest-first, matching the real manager's contract.
  return {
    listAgents: () => [...records].sort((a, b) => b.startedAt - a.startedAt),
    listTombstones: () => [],
  } as unknown as AgentManager;
}

function managerWithTombstones(...entries: AgentTombstone[]): AgentManager {
  return {
    listAgents: () => [],
    listTombstones: () => [...entries].sort((a, b) => b.completedAt - a.completedAt),
  } as unknown as AgentManager;
}

function tombstone(over: Partial<AgentTombstone> = {}): AgentTombstone {
  return {
    handle: "explore",
    id: "t1",
    type: "Explore" as AgentTombstone["type"],
    description: "audit the RPC path",
    sessionFile: "/sessions/explore.jsonl",
    completedAt: 5000,
    ...over,
  };
}

const suggest = (provider: ReturnType<typeof createMentionProvider>, line: string) =>
  provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

const agentRows = (result: Awaited<ReturnType<typeof suggest>>) =>
  (result?.items ?? []).filter(item => !(FILE_SUGGESTIONS.items as unknown[]).includes(item));

describe("agent suggestions", () => {
  it("lists matching handles above pi's files rather than instead of them", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    const result = await suggest(provider, "@ex");

    expect(result).toEqual({
      items: [
        { value: "@explore", label: "@explore", description: "send message · running · find flaky tests" },
        ...FILE_SUGGESTIONS.items,
      ],
      prefix: "@ex",
    });
    expect(current.getSuggestions).toHaveBeenCalledWith(["@ex"], 0, 3, expect.objectContaining({ signal: expect.anything() }));
  });

  it("offers every agent on a bare @, and still offers files", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore" }), record({ handle: "plan", startedAt: 2000 })), []),
      () => true,
    );

    const result = await suggest(provider, "@");

    expect(result?.items.map(i => i.value)).toEqual(["@explore", "@plan", "@src/index.ts"]);
  });

  it("offers agents alone when no file matched", async () => {
    const current = builtIn();
    current.getSuggestions.mockResolvedValue(null);
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("still offers agents when the wrapped provider throws", async () => {
    const current = builtIn();
    current.getSuggestions.mockRejectedValue(new Error("inner provider exploded"));
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("still offers agents when the wrapped provider throws synchronously", async () => {
    const current = builtIn();
    current.getSuggestions.mockImplementation(() => { throw new Error("sync boom"); });
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@ex")).toEqual({
      items: [{ value: "@explore", label: "@explore", description: "send message · running · find flaky tests" }],
      prefix: "@ex",
    });
  });

  it("warns once about a failing inner provider, not once per keystroke", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const current = builtIn();
      current.getSuggestions.mockRejectedValue(new Error("inner provider exploded"));
      const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

      for (const line of ["@e", "@ex", "@exp"]) await suggest(provider, line);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[pi-subagents]");
    } finally {
      warn.mockRestore();
    }
  });

  it("returns pi's list untouched when no agent exists at all", async () => {
    const provider = createMentionProvider(builtIn(), () => [], () => true);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("puts steerable agents first, then earliest-launched", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(
        record({ handle: "explore", status: "completed", startedAt: 1000 }),
        record({ handle: "explore-3", status: "running", startedAt: 3000 }),
        record({ handle: "explore-2", status: "running", startedAt: 2000 }),
      ), []),
      () => true,
    );

    const result = await suggest(provider, "@ex");

    expect(agentRows(result).map(i => i.value)).toEqual(["@explore-2", "@explore-3", "@explore"]);
  });

  it("matches case-insensitively", async () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(agentRows(await suggest(provider, "@EX")).map(i => i.value)).toEqual(["@explore"]);
  });

  it("completes a mention typed mid-message", async () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect((await suggest(provider, "ask @ex"))?.prefix).toBe("@ex");
  });
});

describe("agents that have never run", () => {
  const TYPES = [
    { name: "Explore", description: "Fast codebase exploration. Read-only, medium breadth." },
    { name: "code-review", description: "Reviews a diff." },
  ];

  it("offers a registered type with no live instance, and says it will start one", async () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(), TYPES), () => true);

    const result = await suggest(provider, "@ex");

    expect(agentRows(result)).toEqual([{
      value: "@explore",
      label: "@explore",
      description: "start agent · Fast codebase exploration.",
    }]);
    expect(result?.prefix).toBe("@ex");
  });

  it("lets a live agent own its handle instead of listing the type twice", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore" })), TYPES),
      () => true,
    );

    const result = await suggest(provider, "@ex");

    expect(agentRows(result).map(i => i.value)).toEqual(["@explore"]);
    expect(agentRows(result)[0].description).toBe("send message · running · find flaky tests");
  });

  it("still offers the type once its only instance has finished, as a resume", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", status: "completed" })), TYPES),
      () => true,
    );

    expect((await suggest(provider, "@ex"))?.items[0].description)
      .toBe("resume · completed · find flaky tests");
  });

  it("lists live agents before startable types", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "plan" })), TYPES),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@")).map(i => i.value))
      .toEqual(["@plan", "@explore", "@code-review"]);
  });
});

describe("delegation to pi's provider", () => {
  it("delegates when no handle matches the typed prefix", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@zz")).toBe(FILE_SUGGESTIONS);
    expect(current.getSuggestions).toHaveBeenCalled();
  });

  it("delegates a path-shaped token even when its first segment names an agent", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "@explore/notes.md")).toBe(FILE_SUGGESTIONS);
    expect(current.getSuggestions).toHaveBeenCalled();
  });

  it("delegates an @ that is not at a token boundary", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

    expect(await suggest(provider, "mail@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("never claims nested children — nothing can address them", async () => {
    const current = builtIn();
    const nested = record({ handle: "explore", parentAgentId: "parent-1" });
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(nested), []), () => true);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });

  it("delegates everything while mentions are disabled", async () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => false);

    expect(await suggest(provider, "@ex")).toBe(FILE_SUGGESTIONS);
  });
});

describe("composing with another extension's provider", () => {
  const TYPES = [{ name: "Explore", description: "Fast codebase exploration." }];

  function hashWrapper(current: any) {
    return {
      triggerCharacters: ["#"],
      getSuggestions: vi.fn(async (lines: string[], line: number, col: number, opts: any) =>
        /(^|\s)#\w*$/.test(lines[line].slice(0, col))
          ? { items: [{ value: "#general", label: "#general" }], prefix: "#" }
          : current.getSuggestions(lines, line, col, opts)),
      applyCompletion: vi.fn((...args: any[]) => (current.applyCompletion as any)(...args)),
    };
  }

  it("delegates to a provider registered before us", async () => {
    const base = builtIn();
    const provider = createMentionProvider(
      hashWrapper(base) as any,
      () => mentionRoster(managerWith(), TYPES),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@ex")).map(i => i.value)).toEqual(["@explore"]);
    expect((await suggest(provider, "#gen"))?.items.map(i => i.value)).toEqual(["#general"]);
    expect(await suggest(provider, "@src/")).toBe(FILE_SUGGESTIONS);
  });

  it("is still reachable through a provider registered after us", async () => {
    const base = builtIn();
    const ours = createMentionProvider(base, () => mentionRoster(managerWith(), TYPES), () => true);
    const outer = hashWrapper(ours) as any;

    expect(agentRows(await outer.getSuggestions(["@ex"], 0, 3, { signal: new AbortController().signal }))
      .map(i => i.value)).toEqual(["@explore"]);
    expect((await outer.getSuggestions(["#g"], 0, 2, { signal: new AbortController().signal }))
      ?.items.map((i: any) => i.value)).toEqual(["#general"]);
  });

  it("lets pi union the chain's trigger characters, as it already does", () => {
    const wrappers = [
      (current: any) => hashWrapper(current),
      (current: any) => createMentionProvider(current, () => mentionRoster(managerWith(), TYPES), () => true),
    ];
    let provider: any = builtIn();
    const collected: string[] = [];
    for (const wrap of wrappers) {
      provider = wrap(provider);
      collected.push(...(provider.triggerCharacters ?? []));
    }

    expect(provider.triggerCharacters).toEqual(["@"]);
    expect([...new Set(collected)]).toEqual(["#", "@"]);
  });

  it("can be rebuilt from the same factory without accumulating state", () => {
    const roster = () => mentionRoster(managerWith(record({ handle: "explore" })), []);
    const first = createMentionProvider(builtIn(), roster, () => true);
    const second = createMentionProvider(builtIn(), roster, () => true);

    expect(second.triggerCharacters).toEqual(first.triggerCharacters);
  });
});

describe("against pi's real provider", () => {
  const real = () => new CombinedAutocompleteProvider([], process.cwd(), null);
  const provider = () =>
    createMentionProvider(real(), () => mentionRoster(managerWith(record({ handle: "explore" })), []), () => true);

  it("inserts the handle and a trailing space at the start of a line", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;

    expect(p.applyCompletion(["@ex"], 0, 3, suggestions.items[0], suggestions.prefix)).toEqual({
      lines: ["@explore "],
      cursorLine: 0,
      cursorCol: 9,
    });
  });

  it("replaces only the mention token when it sits mid-line", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "ask @ex"))!;

    expect(p.applyCompletion(["ask @ex"], 0, 7, suggestions.items[0], suggestions.prefix)).toEqual({
      lines: ["ask @explore "],
      cursorLine: 0,
      cursorCol: 13,
    });
  });

  it("keeps text after the cursor intact", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;

    expect(p.applyCompletion(["@ex please"], 0, 3, suggestions.items[0], suggestions.prefix).lines)
      .toEqual(["@explore  please"]);
  });

  it("inserts a FILE-shaped row from OUR prefix, character for character", async () => {
    const p = provider();
    const suggestions = (await suggest(p, "@ex"))!;
    const fileRow = { value: "@examples/agent-tool-description.md", label: "agent-tool-description.md" };

    expect(p.applyCompletion(["@ex"], 0, 3, fileRow, suggestions.prefix).lines)
      .toEqual(["@examples/agent-tool-description.md "]);
    expect(p.applyCompletion(["ask @ex now"], 0, 7, fileRow, suggestions.prefix).lines)
      .toEqual(["ask @examples/agent-tool-description.md  now"]);
  });

  it("declares a trigger character the editor will actually accept", () => {
    for (const character of provider().triggerCharacters ?? []) {
      expect(character.length).toBe(1);
      expect(character).not.toBe("/");
      expect(character.trim()).toBe(character);
    }
  });
});

describe("insertion and trigger plumbing", () => {
  it("hands applyCompletion to pi — its @-branch already inserts value plus a space", () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(), []), () => true);
    const item = { value: "@explore", label: "@explore" };

    expect(provider.applyCompletion(["@ex"], 0, 3, item, "@ex")).toEqual({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    });
    expect(current.applyCompletion).toHaveBeenCalledWith(["@ex"], 0, 3, item, "@ex");
  });

  it("keeps pi's file-completion gate rather than forcing it open", () => {
    const current = builtIn();
    const provider = createMentionProvider(current, () => mentionRoster(managerWith(), []), () => true);

    expect(provider.shouldTriggerFileCompletion?.(["/model"], 0, 6)).toBe(false);
  });

  it("declares @ and nothing else", () => {
    const provider = createMentionProvider(builtIn(), () => mentionRoster(managerWith(), []), () => true);

    expect(provider.triggerCharacters).toEqual(["@"]);
  });
});

describe("named agents and evicted ones", () => {
  it("lists a named agent once, under its alias, and says what type it is", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running", description: "audit the auth flow" })), []),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@"))).toEqual([
      { value: "@auth-audit", label: "@auth-audit", description: "send message · Explore · running · audit the auth flow" },
    ]);
  });

  it("leaves an unnamed agent's row free of a redundant type", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWith(record({ handle: "explore", type: "Explore", status: "running", description: "find flaky tests" })), []),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description).toBe("send message · running · find flaky tests");
  });

  it("still resolves the unlisted type handle of a named agent", () => {
    const roster = mentionRoster(
      managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running" })),
      [{ name: "Explore", description: "search" }],
    );

    expect(roster.map(t => t.handle)).toEqual(["auth-audit"]);
  });

  it("offers an evicted agent as a resume, after the live ones", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), []),
      () => true,
    );

    expect(agentRows(await suggest(provider, "@"))).toEqual([
      { value: "@explore", label: "@explore", description: "resume · Explore · audit the RPC path" },
    ]);
  });

  it("puts live agents ahead of resumable ones", async () => {
    const manager = {
      listAgents: () => [record({ handle: "plan", type: "Plan", status: "running" })],
      listTombstones: () => [tombstone()],
    } as unknown as AgentManager;
    const provider = createMentionProvider(builtIn(), () => mentionRoster(manager, []), () => true);

    expect(agentRows(await suggest(provider, "@")).map(i => i.value)).toEqual(["@plan", "@explore"]);
  });

  it("keeps an aliased tombstone's type handle reserved too", () => {
    const roster = mentionRoster(
      managerWithTombstones(tombstone({ handle: "explore", alias: "auth-audit" })),
      [{ name: "Explore", description: "search" }],
    );

    expect(roster.map(t => t.handle)).toEqual(["auth-audit"]);
  });

  it("does not offer a startable type whose handle a tombstone still holds", () => {
    const roster = mentionRoster(managerWithTombstones(tombstone()), [{ name: "Explore", description: "search" }]);

    expect(roster).toHaveLength(1);
    expect(roster[0].kind).toBe("tombstone");
  });
});

describe("rows carry the display name, not the raw type", () => {
  const label = (type: string) => (type === "Explore" ? "Auth Auditor" : type);

  it("names an aliased agent by its label", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(
        managerWith(record({ handle: "explore", alias: "auth-audit", type: "Explore", status: "running", description: "audit the auth flow" })),
        [],
        label,
      ),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description)
      .toBe("send message · Auth Auditor · running · audit the auth flow");
  });

  it("names a resumable agent by its label", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), [], label),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description)
      .toBe("resume · Auth Auditor · audit the RPC path");
  });

  it("falls back to the raw type when no resolver is supplied", async () => {
    const provider = createMentionProvider(
      builtIn(),
      () => mentionRoster(managerWithTombstones(tombstone()), []),
      () => true,
    );

    expect((await suggest(provider, "@"))!.items[0].description).toContain("· Explore ·");
  });
});
