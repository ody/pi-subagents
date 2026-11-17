import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "../manager/agent-manager.js";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-format.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT, VIEWPORT_WIDTH_PCT } from "./conversation-viewer.js";

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
}

export class ConversationViewerOpener {
  private readonly closers = new Set<() => void>();

  constructor(private readonly deps: ConversationViewerOpenerDeps) {}

  async open(ui: ViewerUI, record: AgentRecord): Promise<void> {
    const session = record.session;
    if (!session) {
      ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const { manager, showCost } = this.deps;
    const activity = manager.getActivity(record.id);
    let close: (() => void) | undefined;

    try {
      await ui.custom<undefined>(
        (tui, theme, keybindings, done) => {
          close = () => done(undefined);
          this.closers.add(close);
          return new ConversationViewer(
            tui,
            session,
            record,
            activity,
            theme,
            done,
            () => {
              if (manager.abort(record.id, "user")) ui.notify(`Stopped "${record.description}".`, "info");
            },
            keybindings,
            (message: string) => manager.steer(record.id, message),
            showCost(),
          );
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

  close(): void {
    for (const close of [...this.closers]) close();
    this.closers.clear();
  }
}
