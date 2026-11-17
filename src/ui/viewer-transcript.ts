import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";

type SessionMessage = AgentSession["messages"][number];
type ToolResultMessage = Extract<SessionMessage, { role: "toolResult" }>;
type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>;
type UserMessage = Extract<SessionMessage, { role: "user" }>;

interface Block {
  component: Component & { setExpanded?(expanded: boolean): void };
  spaced: boolean;
}

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function truncatedOutput(output: string): NonNullable<Parameters<BashExecutionComponent["setComplete"]>[2]> {
  const lines = output.split("\n").length;
  const bytes = Buffer.byteLength(output);
  return {
    content: output,
    truncated: true,
    truncatedBy: null,
    totalLines: lines,
    totalBytes: bytes,
    outputLines: lines,
    outputBytes: bytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: lines,
    maxBytes: bytes,
  };
}

function failedToolText(message: AssistantMessage): string {
  if (message.stopReason === "aborted") return "Operation aborted";
  return message.errorMessage || "Error";
}

export class ViewerTranscript {
  private expanded = false;
  private readonly markdownTheme: MarkdownTheme = getMarkdownTheme();
  private readonly messageBlocks = new Map<SessionMessage, Block[]>();
  private readonly toolBlocks = new Map<string, ToolExecutionComponent>();
  private readonly finishedTools = new Set<string>();

  constructor(
    private readonly tui: TUI,
    private readonly session: AgentSession,
  ) {}

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const blocks of this.messageBlocks.values()) {
      for (const block of blocks) block.component.setExpanded?.(this.expanded);
    }
    for (const tool of this.toolBlocks.values()) tool.setExpanded(this.expanded);
  }

  invalidate(): void {
    for (const blocks of this.messageBlocks.values()) {
      for (const block of blocks) block.component.invalidate();
    }
    for (const tool of this.toolBlocks.values()) tool.invalidate();
  }

  render(width: number): string[] {
    const results = new Map<string, ToolResultMessage>();
    for (const message of this.session.messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }
    const lines: string[] = [];
    const add = (block: Block): void => {
      const rendered = block.component.render(width);
      if (rendered.length === 0) return;
      if (block.spaced && lines.length > 0) lines.push("");
      lines.push(...rendered);
    };
    for (const message of this.session.messages) {
      for (const block of this.blocksFor(message)) add(block);
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const tool = this.toolFor(message, part, results.get(part.id));
          add({ component: tool, spaced: false });
        }
      }
    }
    return lines;
  }

  private blocksFor(message: SessionMessage): Block[] {
    let blocks = this.messageBlocks.get(message);
    if (!blocks) {
      blocks = this.createBlocks(message);
      for (const block of blocks) block.component.setExpanded?.(this.expanded);
      this.messageBlocks.set(message, blocks);
    }
    return blocks;
  }

  private createBlocks(message: SessionMessage): Block[] {
    const theme = this.markdownTheme;
    switch (message.role) {
      case "user":
        return this.userBlocks(message);
      case "assistant":
        return [{ component: new AssistantMessageComponent(message, false, theme), spaced: false }];
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
        if (message.output) component.appendOutput(message.output);
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated ? truncatedOutput(message.output) : undefined,
          message.fullOutputPath,
        );
        return [{ component, spaced: false }];
      }
      case "custom": {
        if (!message.display) return [];
        const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
        return [{ component: new CustomMessageComponent(message, renderer, theme), spaced: false }];
      }
      case "compactionSummary":
        return [{ component: new CompactionSummaryMessageComponent(message, theme), spaced: true }];
      case "branchSummary":
        return [{ component: new BranchSummaryMessageComponent(message, theme), spaced: true }];
      default:
        return [];
    }
  }

  private userBlocks(message: UserMessage): Block[] {
    const text = userText(message);
    if (!text.trim()) return [];
    const skill = parseSkillBlock(text);
    if (!skill) return [{ component: new UserMessageComponent(text, this.markdownTheme), spaced: true }];
    const blocks: Block[] = [
      { component: new SkillInvocationMessageComponent(skill, this.markdownTheme), spaced: true },
    ];
    if (skill.userMessage) {
      blocks.push({ component: new UserMessageComponent(skill.userMessage, this.markdownTheme), spaced: true });
    }
    return blocks;
  }

  private toolFor(
    message: AssistantMessage,
    call: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
    result: ToolResultMessage | undefined,
  ): ToolExecutionComponent {
    let tool = this.toolBlocks.get(call.id);
    if (!tool) {
      const { extensionRunner } = this.session;
      const definition = extensionRunner.resolveToolRenderers(call.name, () => this.session.getToolDefinition(call.name));
      tool = new ToolExecutionComponent(
        call.name,
        call.id,
        call.arguments,
        undefined,
        definition,
        this.tui,
        this.session.sessionManager.getCwd(),
      );
      tool.setArgsComplete();
      tool.markExecutionStarted();
      tool.setExpanded(this.expanded);
      this.toolBlocks.set(call.id, tool);
    }
    if (!this.finishedTools.has(call.id)) {
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        tool.updateResult({ content: [{ type: "text", text: failedToolText(message) }], isError: true });
        this.finishedTools.add(call.id);
      } else if (result) {
        tool.updateResult(result);
        this.finishedTools.add(call.id);
      }
    }
    return tool;
  }
}
