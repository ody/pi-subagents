import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export interface BootedPi {
  pi: any;
  tools: Map<string, any>;
  lifecycle: Map<string, any>;
  entryRenderers: Map<string, any>;
  registeredFlags: Map<string, any>;
  commands: Map<string, any>;
}

export function makePi(flags: Record<string, boolean | string> = {}): BootedPi {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const registeredFlags = new Map<string, any>();
  const commands = new Map<string, any>();
  const activeTools: string[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn((customType: string, renderer: any) => entryRenderers.set(customType, renderer)),
    registerTool: vi.fn((t: any) => {
      tools.set(t.name, t);
      if (!activeTools.includes(t.name)) activeTools.push(t.name);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerFlag: vi.fn((name: string, options: any) => registeredFlags.set(name, options)),
    getFlag: vi.fn((name: string) => flags[name]),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    getAllTools: vi.fn(() => [] as any[]),
    getCommands: vi.fn(() => [] as any[]),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools.length = 0;
      activeTools.push(...names);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
  } as any;
  return { pi, tools, lifecycle, entryRenderers, registeredFlags, commands };
}

export function ctx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
    ...overrides,
  } as any;
}

export const textOf = (r: any): string => r.content[0].text;

export const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

export interface Hermetic {
  dir: string;
  restore: () => void;
}

export function hermeticDir(opts: {
  settings?: Record<string, unknown>;
  agentFiles?: Record<string, string>;
} = {}): Hermetic {
  const dir = mkdtempSync(join(tmpdir(), "pi-boot-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-boot-agentdir-"));
  const prevCwd = process.cwd();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;

  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (opts.settings) {
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(opts.settings));
  }
  if (opts.agentFiles) {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    for (const [name, content] of Object.entries(opts.agentFiles)) {
      writeFileSync(join(dir, ".pi", "agents", `${name}.md`), content);
    }
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = agentDir;
  process.chdir(dir);

  return {
    dir,
    restore() {
      process.chdir(prevCwd);
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
