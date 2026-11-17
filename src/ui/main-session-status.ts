export type MainSessionMessage = { role?: string; content?: unknown };

export class MainSessionStatus {
  private running = false;
  private lastLine = "";
  private readonly listeners = new Set<() => void>();

  get isRunning(): boolean {
    return this.running;
  }

  get lastMessageLine(): string {
    return this.lastLine;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  agentStart(): void {
    this.running = true;
    this.notify();
  }

  agentEnd(): void {
    this.running = false;
    this.notify();
  }

  messageEnd(message: MainSessionMessage): void {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const line = firstTextLine(message.content);
    if (!line) return;
    this.lastLine = line;
    this.notify();
  }

  reset(): void {
    this.running = false;
    this.lastLine = "";
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function firstTextLine(content: unknown[]): string {
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") continue;
    for (const line of block.text.split(/\r?\n/)) {
      const trimmed = line.replace(/\s+/g, " ").trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}
