import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  forEachDescendantOfKinds,
  forEachDescendantWhere,
  statementsOfKind,
} from "./rawDescent.js";

import type { SourceFile } from "ts-morph";

function parse(source: string): SourceFile {
  return createTestProject().createSourceFile("/probe.ts", source);
}

const CALLS = new Set([SyntaxKind.CallExpression, SyntaxKind.ArrowFunction]);

function visitedTexts(root: Node, skipArrows = false): string[] {
  const texts: string[] = [];
  forEachDescendantOfKinds(root, CALLS, (node) => {
    texts.push(node.getText());
    return skipArrows && Node.isArrowFunction(node);
  });
  return texts;
}

describe("forEachDescendantOfKinds", () => {
  it("visits the same nodes as forEachDescendant, in the same order", () => {
    const file = parse(
      "const a = f(g(1), () => h());\nif (a) { k(a).m(); }\nexport default n();\n",
    );
    const expected: Node[] = [];
    file.forEachDescendant((node) => {
      if (CALLS.has(node.getKind())) {
        expected.push(node);
      }
    });
    const visited: Node[] = [];
    forEachDescendantOfKinds(file, CALLS, (node) => {
      visited.push(node);
      return false;
    });
    expect(visited).toEqual(expected);
    expect(visited.every((node, at) => node === expected[at])).toBe(true);
  });

  it("does not go below a node the visit says to skip", () => {
    const file = parse("f(() => g());\n");
    expect(visitedTexts(file, true)).toEqual(["f(() => g())", "() => g()"]);
    expect(visitedTexts(file)).toEqual(["f(() => g())", "() => g()", "g()"]);
  });

  it("leaves out type annotations, type arguments and type declarations", () => {
    const file = parse(
      [
        "type Alias = { [key: string]: ReturnType<typeof make> };",
        "interface Shape { [Symbol.iterator](): void }",
        "declare const ambient: number;",
        "declare module 'lib' { export function there(): void; }",
        "function run<T extends { k: string } = { k: 'x' }>(value: T): T { return value; }",
        "const kept: Array<() => void> = run<{ k: string }>(make());",
      ].join("\n"),
    );
    expect(visitedTexts(file)).toEqual([
      "run<{ k: string }>(make())",
      "make()",
    ]);
  });
});

describe("forEachDescendantWhere", () => {
  it("visits what the test picks from the compiler node", () => {
    const file = parse("process.env.PORT;\nother.env.PORT;\n");
    const picked: string[] = [];
    forEachDescendantWhere(
      file,
      (raw) =>
        raw.kind === SyntaxKind.PropertyAccessExpression &&
        raw.getText(file.compilerNode).startsWith("process"),
      (node) => {
        picked.push(node.getText());
        return false;
      },
    );
    expect(picked).toEqual(["process.env.PORT", "process.env"]);
  });
});

describe("statementsOfKind", () => {
  it("gives what getImportDeclarations and getExportDeclarations give", () => {
    const file = parse(
      [
        "import a from './a';",
        "type T = string;",
        "export { b } from './b';",
        "import * as c from 'c';",
        "export default a;",
      ].join("\n"),
    );
    expect(statementsOfKind(file, SyntaxKind.ImportDeclaration)).toEqual(
      file.getImportDeclarations(),
    );
    expect(statementsOfKind(file, SyntaxKind.ExportDeclaration)).toEqual(
      file.getExportDeclarations(),
    );
    expect(statementsOfKind(file, SyntaxKind.ExportAssignment)).toEqual(
      file.getExportAssignments(),
    );
  });
});
