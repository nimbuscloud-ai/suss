import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  climbSyntax,
  passesValueThrough,
  peelParens,
  peelSyntax,
  peelValue,
} from "./unwrap.js";

import type { SourceFile } from "ts-morph";

function parse(source: string): SourceFile {
  return createTestProject().createSourceFile("/probe.ts", source);
}

/** The one call written in the fixture. */
function theCall(source: string): Node {
  return parse(source).getFirstDescendantByKindOrThrow(
    SyntaxKind.CallExpression,
  );
}

describe("peelSyntax", () => {
  it("peels parentheses, casts, non-null and satisfies", () => {
    const declared = parse(
      "declare function f(): unknown;\nconst x = ((f() as string)! satisfies string);\n",
    ).getVariableDeclarationOrThrow("x");
    const peeled = peelSyntax(declared.getInitializerOrThrow());
    expect(Node.isCallExpression(peeled)).toBe(true);
  });

  it("leaves an await in place", () => {
    const declared = parse(
      "declare function f(): Promise<string>;\nasync function g() {\n  const x = (await f()) as string;\n  return x;\n}\n",
    ).getFirstDescendantByKindOrThrow(SyntaxKind.VariableDeclaration);
    const peeled = peelSyntax(declared.getInitializerOrThrow());
    expect(Node.isAwaitExpression(peeled)).toBe(true);
  });
});

describe("peelParens", () => {
  it("peels parentheses and stops at a cast", () => {
    const declared = parse(
      "declare function f(): unknown;\nconst x = ((f() as string));\n",
    ).getVariableDeclarationOrThrow("x");
    const peeled = peelParens(declared.getInitializerOrThrow());
    expect(Node.isAsExpression(peeled)).toBe(true);
  });
});

describe("peelValue", () => {
  it("peels an await along with the type-level wrappers", () => {
    const declared = parse(
      "declare function f(): Promise<string>;\nasync function g() {\n  const x = (await f()) as string;\n  return x;\n}\n",
    ).getFirstDescendantByKindOrThrow(SyntaxKind.VariableDeclaration);
    const peeled = peelValue(declared.getInitializerOrThrow());
    expect(Node.isCallExpression(peeled)).toBe(true);
  });
});

describe("climbSyntax", () => {
  it("climbs out of parentheses", () => {
    const call = theCall("declare function f(): unknown;\nconst x = (f());\n");
    expect(Node.isParenthesizedExpression(climbSyntax(call))).toBe(true);
  });

  it("climbs a cast inside parentheses, so the parent is what consumes the value", () => {
    const call = theCall(
      "declare function f(): unknown;\nasync function g() {\n  return await (f() as Promise<string>);\n}\n",
    );
    const consumer = climbSyntax(call).getParent();
    expect(consumer !== undefined && Node.isAwaitExpression(consumer)).toBe(
      true,
    );
  });

  it("hands back a node nothing wraps", () => {
    const call = theCall("declare function f(): unknown;\nf();\n");
    expect(climbSyntax(call)).toBe(call);
  });

  it("stops at a parent the node is not the expression of", () => {
    const call = theCall("declare function f(): unknown;\nconst x = [f()];\n");
    expect(climbSyntax(call)).toBe(call);
  });
});

describe("passesValueThrough", () => {
  it("says yes to an await and no to a call", () => {
    const source = parse(
      "declare function f(): Promise<string>;\nasync function g() {\n  return await f();\n}\n",
    );
    const call = source.getFirstDescendantByKindOrThrow(
      SyntaxKind.CallExpression,
    );
    const awaited = source.getFirstDescendantByKindOrThrow(
      SyntaxKind.AwaitExpression,
    );
    expect(passesValueThrough(awaited)).toBe(true);
    expect(passesValueThrough(call)).toBe(false);
  });
});
