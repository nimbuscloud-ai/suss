import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { extractShape } from "./shapes.js";

import type { Expression } from "ts-morph";

/**
 * Wrap an expression as `const _ = <expr>;` so we can reach it as an
 * Expression node without loading a fixture file.
 */
function parseExpression(src: string): Expression {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("in.ts", `const _ = ${src};`);
  const stmt = sf.getFirstDescendantByKindOrThrow(SyntaxKind.VariableStatement);
  const decl = stmt.getDeclarations()[0];
  const init = decl.getInitializer();
  if (init === undefined) {
    throw new Error("missing initializer");
  }
  return init;
}

describe("extractShape", () => {
  describe("primitives", () => {
    it("string literal → text", () => {
      expect(extractShape(parseExpression('"hello"'))).toEqual({
        type: "text",
      });
    });

    it("template literal (no substitution) → text", () => {
      expect(extractShape(parseExpression("`hello`"))).toEqual({
        type: "text",
      });
    });

    it("integer literal → integer", () => {
      expect(extractShape(parseExpression("42"))).toEqual({ type: "integer" });
    });

    it("non-integer numeric → number", () => {
      expect(extractShape(parseExpression("3.14"))).toEqual({ type: "number" });
    });

    it("true / false → boolean", () => {
      expect(extractShape(parseExpression("true"))).toEqual({
        type: "boolean",
      });
      expect(extractShape(parseExpression("false"))).toEqual({
        type: "boolean",
      });
    });

    it("null → null", () => {
      expect(extractShape(parseExpression("null"))).toEqual({ type: "null" });
    });

    it("bare identifier → null (not decomposable)", () => {
      expect(extractShape(parseExpression("user"))).toBeNull();
    });

    it("property access → null (not decomposable)", () => {
      expect(extractShape(parseExpression("user.id"))).toBeNull();
    });
  });

  describe("object literals", () => {
    it("flat record with literal values", () => {
      expect(extractShape(parseExpression('({ error: "not found" })'))).toEqual(
        {
          type: "record",
          properties: { error: { type: "text" } },
        },
      );
    });

    it("property value referencing an identifier chain becomes a ref", () => {
      expect(
        extractShape(parseExpression("({ id: user.id, name: user.name })")),
      ).toEqual({
        type: "record",
        properties: {
          id: { type: "ref", name: "user.id" },
          name: { type: "ref", name: "user.name" },
        },
      });
    });

    it("shorthand property becomes a ref to its identifier", () => {
      expect(extractShape(parseExpression("({ user })"))).toEqual({
        type: "record",
        properties: { user: { type: "ref", name: "user" } },
      });
    });

    it("nested record literal recurses", () => {
      expect(
        extractShape(
          parseExpression('({ user: { id: "u1", email: user.email } })'),
        ),
      ).toEqual({
        type: "record",
        properties: {
          user: {
            type: "record",
            properties: {
              id: { type: "text" },
              email: { type: "ref", name: "user.email" },
            },
          },
        },
      });
    });

    it("mixed literals and refs", () => {
      expect(
        extractShape(parseExpression("({ ok: true, count: 3, note: msg })")),
      ).toEqual({
        type: "record",
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer" },
          note: { type: "ref", name: "msg" },
        },
      });
    });

    it("spread captured in spreads array alongside known fields", () => {
      expect(
        extractShape(parseExpression("({ ...user, admin: true })")),
      ).toEqual({
        type: "record",
        properties: { admin: { type: "boolean" } },
        spreads: [{ sourceText: "user" }],
      });
    });

    it("multiple spreads captured in order", () => {
      expect(
        extractShape(parseExpression("({ ...base, ...overrides, final: 1 })")),
      ).toEqual({
        type: "record",
        properties: { final: { type: "integer" } },
        spreads: [{ sourceText: "base" }, { sourceText: "overrides" }],
      });
    });
  });

  describe("arrays", () => {
    it("empty array → array<unknown>", () => {
      expect(extractShape(parseExpression("[]"))).toEqual({
        type: "array",
        items: { type: "unknown" },
      });
    });

    it("array items shape from first element", () => {
      expect(extractShape(parseExpression('["a", "b", "c"]'))).toEqual({
        type: "array",
        items: { type: "text" },
      });
    });

    it("array of non-decomposable items falls back to ref", () => {
      expect(extractShape(parseExpression("[user, admin]"))).toEqual({
        type: "array",
        items: { type: "ref", name: "user" },
      });
    });
  });

  describe("wrappers", () => {
    it("`x as const` unwraps to inner shape", () => {
      expect(
        extractShape(parseExpression("({ status: 404 } as const)")),
      ).toEqual({
        type: "record",
        properties: { status: { type: "integer" } },
      });
    });

    it("parenthesized expression unwraps", () => {
      expect(extractShape(parseExpression("((({ ok: true })))"))).toEqual({
        type: "record",
        properties: { ok: { type: "boolean" } },
      });
    });
  });
});
