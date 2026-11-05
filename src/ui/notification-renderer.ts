// How completion notifications render in the chat: the
// `subagent-notification` message block.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { NotificationDetails } from "../types.js";
import { formatBatchSummary, formatNotification } from "./notification-block.js";

/** Register the custom notification renderer on pi. */
export function registerNotificationRenderer(
  pi: ExtensionAPI,
  deps: { settings: Readonly<Pick<RuntimeSettings, "showCost">> },
): void {
  const { settings } = deps;
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      // Read per render, never captured at registration.
      const showCost = settings.showCost;
      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(n => formatNotification(n, { expanded, showCost }, theme));
      if (showCost && all.length > 1) {
        const summary = formatBatchSummary(all, theme);
        if (summary) rendered.unshift(summary);
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );
}
