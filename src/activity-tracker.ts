// Spawn callbacks that only repaint.

import type { LifetimeUsage } from "./usage.js";

/**
 * Spawn callbacks that only repaint.
 *
 * The activity state itself lives on `AgentManager` (see `getActivity`), which
 * updates it for every spawn path; these callbacks exist so the tool result,
 * widget and FleetView redraw when it changes.
 */
export function createActivityTracker(onStreamUpdate?: () => void) {
  return {
    onToolActivity: (_activity: { type: "start" | "end"; toolName: string }) => { onStreamUpdate?.(); },
    onTextDelta: (_delta: string, _fullText: string) => { onStreamUpdate?.(); },
    onTurnEnd: (_turnCount: number) => { onStreamUpdate?.(); },
    onSessionCreated: (_session: any) => {},
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => { onStreamUpdate?.(); },
  };
}
