import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

export type ViewerKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand";

export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybinding): boolean;
  getKeys(keybinding: ViewerKeybinding): readonly string[];
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  expand(data: string): boolean;
  label(keybinding: ViewerKeybinding): string;
}

const DEFAULT_KEYS: Record<ViewerKeybinding, KeyId> = {
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.pageUp": "pageUp",
  "tui.select.pageDown": "pageDown",
  "app.tools.expand": "ctrl+o",
};

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    label: (id) => (keybindings ? keybindings.getKeys(id) : [DEFAULT_KEYS[id]]).join("/"),
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    expand: (data) => matches(data, "app.tools.expand", "ctrl+o"),
  };
}
