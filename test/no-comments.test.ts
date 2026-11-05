import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["src", "test"];
const HEADER_SCAN_LINES = 30;

const SIZE_HEADER = /^\s*(\/\/|\/\*+|\*)\s*Size:\s*\S/;
const BIOME_IGNORE = /^\s*(\/\/|\/\*+)\s*biome-ignore\s+\S+:\s*\S/;

const ALLOWLIST: Record<string, number> = {
  "src/agents/agent-file-toggle.ts": 28,
  "src/agents/agent-types.ts": 50,
  "src/agents/custom-agents.ts": 41,
  "src/agents/default-agents.ts": 7,
  "src/config/enabled-models.ts": 16,
  "src/config/model-resolver.ts": 23,
  "src/config/model-scope.ts": 7,
  "src/config/runner-defaults.ts": 13,
  "src/config/runtime-settings.ts": 38,
  "src/config/settings.ts": 45,
  "src/config/thinking-levels.ts": 1,
  "src/index.ts": 136,
  "src/lifecycle-events.ts": 17,
  "src/manager/agent-manager-rules.ts": 7,
  "src/manager/agent-manager.ts": 83,
  "src/manager/agent-resume.ts": 57,
  "src/manager/agent-retention.ts": 30,
  "src/manager/agent-spawn.ts": 80,
  "src/manager/agent-start.ts": 105,
  "src/manager/background-resume.ts": 28,
  "src/manager/completion-notifier.ts": 31,
  "src/manager/group-join.ts": 13,
  "src/manager/notification-format.ts": 10,
  "src/manager/xml.ts": 2,
  "src/platform/env.ts": 1,
  "src/platform/output-file.ts": 28,
  "src/platform/worktree.ts": 32,
  "src/session/agent-runner.ts": 127,
  "src/session/agent-session-shutdown.ts": 8,
  "src/session/child-context.ts": 1,
  "src/session/context.ts": 4,
  "src/session/extension-scope.ts": 37,
  "src/session/prompts.ts": 17,
  "src/session/session-text.ts": 9,
  "src/session/skill-loader.ts": 9,
  "src/tool/abortable.ts": 2,
  "src/tool/activity-tracker.ts": 4,
  "src/tool/agent-call-resolution.ts": 47,
  "src/tool/agent-control-tools.ts": 24,
  "src/tool/agent-tool-background.ts": 18,
  "src/tool/agent-tool-description.ts": 22,
  "src/tool/agent-tool-foreground.ts": 37,
  "src/tool/agent-tool-render.ts": 19,
  "src/tool/agent-tool-resume.ts": 13,
  "src/tool/agent-tool-schedule.ts": 6,
  "src/tool/agent-tool.ts": 21,
  "src/tool/invocation-config.ts": 22,
  "src/tool/nested-tools.ts": 55,
  "src/tool/status-note.ts": 4,
  "src/tool/tool-result.ts": 7,
  "src/triggers/cross-extension-rpc.ts": 52,
  "src/triggers/mention-clone.ts": 42,
  "src/triggers/mention-input.ts": 93,
  "src/triggers/mention.ts": 15,
  "src/triggers/schedule-store.ts": 12,
  "src/triggers/schedule.ts": 50,
  "src/triggers/spawn-funnel.ts": 41,
  "src/types.ts": 74,
  "src/ui/agent-color.ts": 12,
  "src/ui/agent-format.ts": 32,
  "src/ui/agent-mention.ts": 49,
  "src/ui/agent-tree.ts": 14,
  "src/ui/agent-widget.ts": 54,
  "src/ui/agents-menu.ts": 55,
  "src/ui/conversation-viewer.ts": 82,
  "src/ui/create-agent-wizard.ts": 18,
  "src/ui/fleet-list.ts": 69,
  "src/ui/notification-block.ts": 5,
  "src/ui/notification-renderer.ts": 4,
  "src/ui/schedule-menu.ts": 9,
  "src/ui/select-item.ts": 4,
  "src/ui/settings-menu.ts": 24,
  "src/ui/viewer-keys.ts": 3,
  "src/ui/widget-layout.ts": 18,
  "src/usage.ts": 15,
  "test/abort-forced-settle.test.ts": 22,
  "test/abortable.test.ts": 35,
  "test/agent-color-surfaces.test.ts": 8,
  "test/agent-color.test.ts": 2,
  "test/agent-control-tools.test.ts": 1,
  "test/agent-file-bom.test.ts": 10,
  "test/agent-file-toggle.test.ts": 64,
  "test/agent-manager-gc.test.ts": 44,
  "test/agent-manager.test.ts": 199,
  "test/agent-mention-provider.test.ts": 76,
  "test/agent-mention-wiring.test.ts": 121,
  "test/agent-model-display.test.ts": 30,
  "test/agent-runner-e2e.test.ts": 19,
  "test/agent-runner.test.ts": 199,
  "test/agent-startup-error.test.ts": 1,
  "test/agent-tree.test.ts": 1,
  "test/agent-types.test.ts": 23,
  "test/agent-widget.test.ts": 60,
  "test/agents-menu.test.ts": 9,
  "test/background-by-default.test.ts": 6,
  "test/background-resume-wiring.test.ts": 27,
  "test/child-session-shutdown.test.ts": 14,
  "test/clear-completed-wiring.test.ts": 11,
  "test/complexity.test.ts": 6,
  "test/context.test.ts": 4,
  "test/conversation-viewer-keybindings.test.ts": 1,
  "test/conversation-viewer.test.ts": 84,
  "test/cost-display.test.ts": 13,
  "test/cross-extension-rpc.test.ts": 32,
  "test/custom-agents.test.ts": 74,
  "test/documented-defaults.test.ts": 26,
  "test/e2e/isolated-provider.e2e.test.ts": 12,
  "test/e2e/mention-clone-tool-reachability.e2e.test.ts": 12,
  "test/e2e/tool-veto-reachability.e2e.test.ts": 13,
  "test/e2e/usage-reaches-session-stats.e2e.test.ts": 16,
  "test/enabled-models.test.ts": 9,
  "test/env.test.ts": 2,
  "test/ext-templates-e2e.test.ts": 22,
  "test/extension-scope.test.ts": 17,
  "test/fallback-subagent-wiring.test.ts": 19,
  "test/file-size.test.ts": 9,
  "test/fleet-list.test.ts": 105,
  "test/fleet-wiring.test.ts": 7,
  "test/foreground-concurrency-print-mode-e2e.test.ts": 15,
  "test/foreground-concurrency-wiring.test.ts": 15,
  "test/foreground-concurrency.test.ts": 82,
  "test/foreground-result-retrieval.test.ts": 22,
  "test/group-join.test.ts": 10,
  "test/helpers/boot-extension.ts": 18,
  "test/helpers/faux-model-backend.ts": 9,
  "test/helpers/perf-fixtures.ts": 24,
  "test/helpers/pi-ai.ts": 1,
  "test/helpers/print-mode-runner.ts": 106,
  "test/invocation-config.test.ts": 16,
  "test/isolation-param.test.ts": 8,
  "test/lifecycle-events.test.ts": 3,
  "test/manager-registry-guard.test.ts": 20,
  "test/mention-clone.test.ts": 54,
  "test/mention-start-notification.test.ts": 3,
  "test/mention.test.ts": 17,
  "test/model-resolver.test.ts": 17,
  "test/model-scope.test.ts": 18,
  "test/nested-delegation-e2e.test.ts": 34,
  "test/nested-tools.test.ts": 31,
  "test/output-file-compaction-e2e.test.ts": 22,
  "test/output-file-path.test.ts": 21,
  "test/output-file.test.ts": 27,
  "test/output-transcript-wiring.test.ts": 3,
  "test/perf/formatters.bench.ts": 2,
  "test/perf/no-fs-on-render.perf.test.ts": 3,
  "test/perf/render-invariants.perf.test.ts": 19,
  "test/perf/spawn-invariants.perf.test.ts": 5,
  "test/perf/spawn.bench.ts": 7,
  "test/perf/viewer.bench.ts": 18,
  "test/perf/widget.bench.ts": 6,
  "test/print-mode.test.ts": 2,
  "test/prompts.test.ts": 6,
  "test/rpc-inline-agent.test.ts": 3,
  "test/rpc-lifecycle-gating.test.ts": 14,
  "test/rpc-result-consumption.test.ts": 8,
  "test/runner-defaults.test.ts": 9,
  "test/runtime-settings.test.ts": 2,
  "test/schedule-e2e.test.ts": 16,
  "test/schedule-menu.test.ts": 26,
  "test/schedule-params-wiring.test.ts": 23,
  "test/schedule-store.test.ts": 11,
  "test/schedule.test.ts": 42,
  "test/session-text.test.ts": 6,
  "test/settings.test.ts": 48,
  "test/skill-loader.test.ts": 5,
  "test/source-tree.test.ts": 2,
  "test/status-note-wiring.test.ts": 47,
  "test/steer-subagent-wiring.test.ts": 11,
  "test/stop-subagent-wiring.test.ts": 19,
  "test/strict-agent-files-wiring.test.ts": 6,
  "test/subagent-error-status-e2e.test.ts": 12,
  "test/subagents-nested-print-mode-e2e.test.ts": 17,
  "test/subagents-print-mode-e2e.test.ts": 89,
  "test/tool-description-mode.test.ts": 60,
  "test/tool-result.test.ts": 2,
  "test/usage-reporting.test.ts": 50,
  "test/usage.test.ts": 27,
  "test/wait-queued.test.ts": 6,
  "test/widget-layout.test.ts": 2,
  "test/worktree-isolation-e2e.test.ts": 31,
  "test/worktree.test.ts": 60,
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function commentRanges(file: string, text: string): ts.CommentRange[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found = new Map<number, ts.CommentRange>();
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

function lineOf(text: string, pos: number): number {
  return text.slice(0, pos).split("\n").length;
}

function isExempt(text: string, range: ts.CommentRange): boolean {
  const body = text.slice(range.pos, range.end);
  if (range.pos === 0 && body.startsWith("#!")) return true;
  if (lineOf(text, range.pos) <= HEADER_SCAN_LINES && SIZE_HEADER.test(body)) return true;
  return BIOME_IGNORE.test(body);
}

const files = SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
  .filter((path) => path.endsWith(".ts"))
  .map((path) => {
    const text = readFileSync(path, "utf8");
    const rel = relative(ROOT, path).split("\\").join("/");
    const comments = commentRanges(rel, text).filter((range) => !isExempt(text, range));
    return {
      rel,
      text,
      comments,
      where: comments.map((range) => {
        const body = text.slice(range.pos, range.end).trim().replace(/\s+/g, " ");
        return `${rel}:${lineOf(text, range.pos)}: ${body.length > 60 ? `${body.slice(0, 60)}...` : body}`;
      }),
    };
  })
  .sort((a, b) => (a.rel < b.rel ? -1 : 1));

describe("no code comments (ADR 0010)", () => {
  it("finds TypeScript files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("allowlist is sorted by path", () => {
    const paths = Object.keys(ALLOWLIST);
    expect(paths).toEqual([...paths].sort());
  });

  it("allowlist names only existing files", () => {
    const present = new Set(files.map((f) => f.rel));
    expect(Object.keys(ALLOWLIST).filter((rel) => !present.has(rel))).toEqual([]);
  });

  for (const f of files) {
    const pin = ALLOWLIST[f.rel];
    if (pin === undefined) {
      it(`${f.rel} has no comments`, () => {
        expect(f.where, `${f.rel} has ${f.comments.length} comment(s); ADR 0010 allows none`).toEqual([]);
      });
      continue;
    }
    it(`${f.rel} stays at or below its allowlist pin of ${pin}`, () => {
      expect(f.comments.length, `${f.rel} has ${f.comments.length} comment(s), pin is ${pin}`).toBeLessThanOrEqual(pin);
    });
    it(`${f.rel} drops out of the allowlist at 0 comments`, () => {
      expect(
        f.comments.length,
        `${f.rel} reached 0 comments; remove its allowlist entry "${f.rel}": ${pin}`,
      ).toBeGreaterThan(0);
    });
  }
});
