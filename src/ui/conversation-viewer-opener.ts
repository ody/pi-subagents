import { statSync } from "node:fs";
import { type KeybindingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentRecord, AgentTombstone } from "../types.js";
import type { Theme } from "./agent-format.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT, VIEWPORT_WIDTH_PCT, type ViewerTarget } from "./conversation-viewer.js";
import type { MainSessionStatus } from "./main-session-status.js";
import type { StoredTranscript } from "./viewer-transcript.js";

export interface ViewerUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component & { dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
  ): Promise<T>;
}

export interface ConversationViewerOpenerDeps {
  manager: Pick<AgentManager, "getActivity" | "abort" | "steer">;
  showCost: () => boolean;
  mainSession: MainSessionStatus;
}

export type ViewerAgent =
  | { kind: "live"; record: AgentRecord }
  | { kind: "history"; entry: AgentTombstone };

function readTranscript(sessionFile: string): StoredTranscript | undefined {
  try {
    if (!statSync(sessionFile).isFile()) return undefined;
    const manager = SessionManager.open(sessionFile);
    return { messages: manager.buildSessionContext().messages, cwd: manager.getCwd() };
  } catch {
    return undefined;
  }
}

function agentLabel(entry: AgentTombstone): string {
  return `@${entry.alias ?? entry.handle}`;
}

export class ConversationViewerOpener {
  private readonly closers = new Set<() => void>();

  constructor(private readonly deps: ConversationViewerOpenerDeps) {}

  async open(ui: ViewerUI, agent: ViewerAgent): Promise<void> {
    const target = this.targetFor(ui, agent);
    if (!target) return;
    const { showCost, mainSession } = this.deps;
    let close: (() => void) | undefined;

    try {
      await ui.custom<undefined>(
        (tui, theme, keybindings, done) => {
          close = () => done(undefined);
          this.closers.add(close);
          return new ConversationViewer(tui, target, theme, done, keybindings, showCost(), mainSession);
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: `${VIEWPORT_WIDTH_PCT}%`, maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
        },
      );
    } finally {
      if (close) this.closers.delete(close);
    }
  }

  private targetFor(ui: ViewerUI, agent: ViewerAgent): ViewerTarget | undefined {
    if (agent.kind === "history") {
      const transcript = readTranscript(agent.entry.sessionFile);
      if (!transcript) {
        ui.notify(`Could not open ${agentLabel(agent.entry)} — its session file is missing or unreadable: ${agent.entry.sessionFile}`, "warning");
        return undefined;
      }
      return { kind: "history", entry: agent.entry, transcript };
    }

    const { record } = agent;
    const session = record.session;
    if (!session) {
      ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return undefined;
    }
    const { manager } = this.deps;
    return {
      kind: "live",
      session,
      record,
      activity: manager.getActivity(record.id),
      onStop: () => {
        if (manager.abort(record.id, "user")) ui.notify(`Stopped "${record.description}".`, "info");
      },
      onSteer: (message: string) => manager.steer(record.id, message),
    };
  }

  close(): void {
    for (const close of [...this.closers]) close();
    this.closers.clear();
  }
}
