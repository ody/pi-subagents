import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const MANAGER_FILE = "manager/agent-manager.ts";

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile("snippet.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function settledAssignments(text: string): number[] {
  const source = parse(text);
  const lines: number[] = [];
  walk(source, (node) => {
    if (isAssignment(node) && propertyName(node.left) === "settled") lines.push(lineOf(source, node));
  });
  return lines;
}

function onCompleteReferences(text: string): number[] {
  const source = parse(text);
  const lines: number[] = [];
  walk(source, (node) => {
    if (ts.isIdentifier(node) && node.text === "onComplete") lines.push(lineOf(source, node));
  });
  return lines;
}

function enclosing<T extends ts.Node>(node: ts.Node, guard: (node: ts.Node) => node is T): T | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (guard(n)) return n;
  return undefined;
}

function isTailCall(node: ts.Identifier, source: ts.SourceFile): boolean {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) return false;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return false;
  const method = enclosing(node, ts.isMethodDeclaration);
  return method !== undefined && method.name.getText(source) === "settleRun";
}

function managerOnCompleteViolations(text: string): string[] {
  const source = parse(text);
  const problems: string[] = [];
  let tailCalls = 0;
  walk(source, (node) => {
    if (!ts.isIdentifier(node) || node.text !== "onComplete") return;
    const line = lineOf(source, node);
    const owner = enclosing(node, ts.isClassDeclaration);
    if (owner?.name?.text !== "AgentManager") {
      problems.push(`${line}: outside AgentManager`);
    } else if (ts.isPropertyDeclaration(node.parent) && node.parent.name === node) {
      return;
    } else if (enclosing(node, ts.isConstructorDeclaration)) {
      return;
    } else if (isTailCall(node, source)) {
      tailCalls++;
    } else {
      problems.push(`${line}: outside the constructor and the settleRun call`);
    }
  });
  if (tailCalls !== 1) problems.push(`expected one onComplete call in settleRun, found ${tailCalls}`);
  return problems;
}

const files = filesUnder(SRC).filter((path) => path.endsWith(".ts"));

describe("single settle tail (ADR 0033)", () => {
  it("finds src files and the manager", () => {
    expect(files).toContain(MANAGER_FILE);
  });

  for (const path of files.filter((file) => file !== MANAGER_FILE)) {
    const text = readFileSync(join(SRC, path), "utf8");
    it(`src/${path} assigns no .settled`, () => {
      expect(settledAssignments(text)).toEqual([]);
    });
    it(`src/${path} never references onComplete`, () => {
      expect(onCompleteReferences(text)).toEqual([]);
    });
  }

  it("agent-manager.ts references onComplete only in the constructor, its field and the settleRun call", () => {
    expect(managerOnCompleteViolations(readFileSync(join(SRC, MANAGER_FILE), "utf8"))).toEqual([]);
  });

  describe("matchers", () => {
    it("flags settled assignments", () => {
      expect(settledAssignments("record.settled = true;")).toHaveLength(1);
      expect(settledAssignments("x.settled=false")).toHaveLength(1);
      expect(settledAssignments("a.b['settled'] = true")).toHaveLength(1);
      expect(settledAssignments("record.settled ||= true")).toHaveLength(1);
    });

    it("passes reads, comparisons, declarations and destructuring", () => {
      const clean = [
        "if (record.settled) return;",
        "const a = record.settled === true;",
        "interface R { settled?: boolean }",
        "const { settled } = record;",
        "const o = { settled: true };",
      ].join("\n");
      expect(settledAssignments(clean)).toEqual([]);
    });

    it("flags onComplete anywhere outside the manager", () => {
      expect(onCompleteReferences("deps.onComplete?.(record);")).toHaveLength(1);
      expect(onCompleteReferences("const onComplete = 1;")).toHaveLength(1);
      expect(onCompleteReferences("const x = 1;")).toEqual([]);
    });

    it("accepts the constructor, the field and one settleRun call", () => {
      const ok = `class AgentManager {
        private onComplete?: () => void;
        constructor(onComplete?: () => void) { this.onComplete = onComplete; }
        private settleRun(record: R) { try { this.onComplete?.(record); } catch {} }
      }`;
      expect(managerOnCompleteViolations(ok)).toEqual([]);
    });

    it("flags a second call, deps wiring and a missing tail call", () => {
      const twice = `class AgentManager {
        private onComplete?: () => void;
        private settleRun(record: R) { this.onComplete?.(record); }
        private other(record: R) { this.onComplete?.(record); }
      }`;
      expect(managerOnCompleteViolations(twice)).toHaveLength(1);
      const wiring = `class AgentManager {
        private startDeps() { return { onComplete: (r: R) => this.onComplete?.(r) }; }
        private settleRun(record: R) { this.onComplete?.(record); }
      }`;
      expect(managerOnCompleteViolations(wiring)).toHaveLength(2);
      expect(managerOnCompleteViolations("class AgentManager { private onComplete?: () => void; }")).toHaveLength(1);
    });

    it("flags onComplete in another class", () => {
      expect(managerOnCompleteViolations("class Other { f() { this.onComplete?.(); } }").length).toBeGreaterThan(0);
    });
  });
});
