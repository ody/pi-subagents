import { vi } from "vitest";
import { AgentManager } from "../../src/manager/agent-manager.js";

export interface ManagerTap {
  manager(): AgentManager;
  restore(): void;
}

export function tapManager(): ManagerTap {
  let tapped: AgentManager | undefined;
  const original = AgentManager.prototype.spawn;
  const spy = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(function (this: AgentManager, ...args) {
    tapped ??= this;
    return original.apply(this, args);
  });
  return {
    manager() {
      if (!tapped) throw new Error("No AgentManager has spawned yet");
      return tapped;
    },
    restore() {
      spy.mockRestore();
    },
  };
}
