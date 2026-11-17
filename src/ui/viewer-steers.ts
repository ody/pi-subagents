import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { userText } from "./viewer-transcript.js";

interface PendingSteer {
  text: string;
  deliveredBefore: number;
  queued: boolean;
}

export class PendingSteers {
  private entries: PendingSteer[] = [];

  constructor(private readonly session: AgentSession) {}

  add(text: string): void {
    this.entries.push({ text, deliveredBefore: this.delivered(text), queued: false });
  }

  clear(): void {
    this.entries = [];
  }

  texts(): string[] {
    return this.entries.map((entry) => entry.text);
  }

  refresh(): void {
    if (this.entries.length === 0) return;
    const queue = [...this.session.getSteeringMessages()];
    this.entries = this.entries.filter((entry) => {
      const index = queue.indexOf(entry.text);
      if (index !== -1) queue.splice(index, 1);
      const inQueue = index !== -1;
      entry.queued ||= inQueue;
      if (entry.queued && !inQueue) return false;
      return this.delivered(entry.text) <= entry.deliveredBefore;
    });
  }

  private delivered(text: string): number {
    let count = 0;
    for (const message of this.session.messages) {
      if (message.role === "user" && userText(message) === text) count++;
    }
    return count;
  }
}
