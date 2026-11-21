import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "../usage.js";

export function createActivityTracker(onStreamUpdate?: () => void) {
  return {
    onToolActivity: (_activity: { type: "start" | "end"; toolName: string }) => { onStreamUpdate?.(); },
    onTextDelta: (_delta: string, _fullText: string) => { onStreamUpdate?.(); },
    onTurnEnd: (_turnCount: number) => { onStreamUpdate?.(); },
    onSessionCreated: (_session: AgentSession) => {},
    onAssistantUsage: (_usage: LifetimeUsage) => { onStreamUpdate?.(); },
  };
}
