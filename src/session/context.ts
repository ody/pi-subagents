import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function extractText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

function messageLine(message: Extract<BranchEntry, { type: "message" }>["message"]): string | undefined {
  let label: string;
  let text: string;
  if (message.role === "user") {
    label = "User";
    text = typeof message.content === "string" ? message.content : extractText(message.content);
  } else if (message.role === "assistant") {
    label = "Assistant";
    text = extractText(message.content);
  } else {
    return undefined;
  }
  return text.trim() ? `[${label}]: ${text.trim()}` : undefined;
}

function entryLine(entry: BranchEntry): string | undefined {
  if (entry.type === "message") return messageLine(entry.message);
  if (entry.type === "compaction" && entry.summary) return `[Summary]: ${entry.summary}`;
  return undefined;
}

export function buildParentContext(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  if (!entries || entries.length === 0) return "";

  const parts = entries.map(entryLine).filter((line) => line !== undefined);

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
