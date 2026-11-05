import type { AgentSession } from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

export async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) {
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch {}
  try { session?.dispose?.(); } catch {}
}
