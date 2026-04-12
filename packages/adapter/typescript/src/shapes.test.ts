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

/**
 * Like `parseExpression` but accepts a prelude of type / variable
 * declarations so the type checker can resolve identifiers in `src`.
 * Returns the initializer of the final `const _ = <src>;` line.
 */
function parseExpressionWithPrelude(prelude: string, src: string): Expression {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, noEmit: true },
  });
  const sf = project.createSourceFile("in.ts", `${prelude}\nconst _ = ${src};`);
  const statements = sf.getVariableStatements();
  const decl = statements[statements.length - 1].getDeclarations()[0];
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

    it("array of untyped bare identifiers falls back to per-element refs", () => {
      // Neither `user` nor `admin` is declared in this stub program, so the
      // type checker infers `any` and each element degrades to a source-text
      // ref. Element shapes are deduped and collapsed — here they differ,
      // producing a union.
      expect(extractShape(parseExpression("[user, admin]"))).toEqual({
        type: "array",
        items: {
          type: "union",
          variants: [
            { type: "ref", name: "user" },
            { type: "ref", name: "admin" },
          ],
        },
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

    it("angle-bracket type assertion unwraps", () => {
      // Parsed in a .ts file (no JSX), <T>x is a type assertion.
      expect(extractShape(parseExpression("<const>({ ok: true })"))).toEqual({
        type: "record",
        properties: { ok: { type: "boolean" } },
      });
    });

    it("non-null assertion (`!`) unwraps", () => {
      expect(extractShape(parseExpression("({ ok: true }!)"))).toEqual({
        type: "record",
        properties: { ok: { type: "boolean" } },
      });
    });

    it("satisfies clause unwraps", () => {
      expect(
        extractShape(parseExpression("({ ok: true } satisfies object)")),
      ).toEqual({
        type: "record",
        properties: { ok: { type: "boolean" } },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Expanded primitive / syntax coverage
  // -------------------------------------------------------------------------

  describe("expression syntax", () => {
    it("negative integer literal → integer", () => {
      expect(extractShape(parseExpression("-42"))).toEqual({ type: "integer" });
    });

    it("negative float literal → number", () => {
      expect(extractShape(parseExpression("-3.14"))).toEqual({
        type: "number",
      });
    });

    it("unary plus on integer → integer", () => {
      expect(extractShape(parseExpression("+42"))).toEqual({ type: "integer" });
    });

    it("template literal with substitution → text", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional TS source
      expect(extractShape(parseExpression("`hello ${name}`"))).toEqual({
        type: "text",
      });
    });

    it("`undefined` identifier → undefined shape", () => {
      expect(extractShape(parseExpression("undefined"))).toEqual({
        type: "undefined",
      });
    });

    it("BigInt literal → bigint ref", () => {
      expect(extractShape(parseExpression("123n"))).toEqual({
        type: "ref",
        name: "bigint",
      });
    });

    it("ternary on literal branches → union", () => {
      expect(extractShape(parseExpression('(flag ? "yes" : 42)'))).toEqual({
        type: "union",
        variants: [{ type: "text" }, { type: "integer" }],
      });
    });

    it("ternary where both branches produce the same shape collapses", () => {
      expect(extractShape(parseExpression('(flag ? "a" : "b")'))).toEqual({
        type: "text",
      });
    });

    it("heterogeneous array collapses to array<union>", () => {
      expect(extractShape(parseExpression('[1, "two", true]'))).toEqual({
        type: "array",
        items: {
          type: "union",
          variants: [
            { type: "integer" },
            { type: "text" },
            { type: "boolean" },
          ],
        },
      });
    });

    it("homogeneous array stays as single-item-type array", () => {
      expect(extractShape(parseExpression("[1, 2, 3]"))).toEqual({
        type: "array",
        items: { type: "integer" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Type-checker fallback
  // -------------------------------------------------------------------------

  describe("type-checker resolution", () => {
    it("bare identifier with declared record type expands to record", () => {
      const expr = parseExpressionWithPrelude(
        "declare const user: { id: string; name: string; active: boolean };",
        "user",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          id: { type: "text" },
          name: { type: "text" },
          active: { type: "boolean" },
        },
      });
    });

    it("property access on a typed record resolves to the field's primitive", () => {
      const expr = parseExpressionWithPrelude(
        "declare const user: { id: string; age: number };",
        "user.age",
      );
      expect(extractShape(expr)).toEqual({ type: "number" });
    });

    it("call expression return type is resolved", () => {
      const expr = parseExpressionWithPrelude(
        "declare function getUser(): { id: string };",
        "getUser()",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: { id: { type: "text" } },
      });
    });

    it("awaited promise returns its resolved type", () => {
      const sf = parseExpressionWithPrelude(
        "async function _run() {\n  const p: Promise<{ id: string }> = null as any;\n  return await p;\n}",
        "1",
      ).getSourceFile();
      const awaitNode = sf.getFirstDescendantByKindOrThrow(
        SyntaxKind.AwaitExpression,
      );
      expect(extractShape(awaitNode)).toEqual({
        type: "record",
        properties: { id: { type: "text" } },
      });
    });

    it("optional fields produce union-with-undefined", () => {
      const expr = parseExpressionWithPrelude(
        "declare const user: { id: string; email?: string };",
        "user",
      );
      const shape = extractShape(expr);
      expect(shape?.type).toBe("record");
      if (shape?.type !== "record") {
        return;
      }
      expect(shape.properties.id).toEqual({ type: "text" });
      expect(shape.properties.email.type).toBe("union");
      if (shape.properties.email.type !== "union") {
        return;
      }
      expect(shape.properties.email.variants).toEqual(
        expect.arrayContaining([{ type: "text" }, { type: "undefined" }]),
      );
      expect(shape.properties.email.variants).toHaveLength(2);
    });

    it("recursive types terminate at a ref", () => {
      const expr = parseExpressionWithPrelude(
        "interface Node { name: string; children: Node[] }\ndeclare const root: Node;",
        "root",
      );
      const shape = extractShape(expr);
      // Outer: record with name, children. Children: array<Node> where Node
      // is either re-expanded (depth-limited) or bottoms out at a ref.
      expect(shape?.type).toBe("record");
      if (shape?.type === "record") {
        expect(shape.properties.name).toEqual({ type: "text" });
        expect(shape.properties.children.type).toBe("array");
      }
    });

    it("opaque named types (Date, Promise) surface as refs, not records", () => {
      const expr = parseExpressionWithPrelude(
        "declare const createdAt: Date;",
        "createdAt",
      );
      expect(extractShape(expr)).toEqual({ type: "ref", name: "Date" });
    });

    it("declared union type becomes a TypeShape union", () => {
      // Heterogeneous unions (string | number) survive widening at a
      // `declare const` reference site. Same-kind literal unions (e.g.
      // `"a" | "b"`) get widened to `string`, so they aren't useful here.
      const expr = parseExpressionWithPrelude(
        "declare const v: string | number;",
        "v",
      );
      const shape = extractShape(expr);
      expect(shape?.type).toBe("union");
      if (shape?.type === "union") {
        expect(shape.variants).toEqual(
          expect.arrayContaining([{ type: "text" }, { type: "number" }]),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Spread resolution via the type checker
  // -------------------------------------------------------------------------

  describe("spread resolution", () => {
    it("typed spread source inlines its properties", () => {
      const expr = parseExpressionWithPrelude(
        "declare const user: { id: string; name: string };",
        "({ ...user, admin: true })",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          id: { type: "text" },
          name: { type: "text" },
          admin: { type: "boolean" },
        },
      });
    });

    it("later property overrides a spread-provided field", () => {
      const expr = parseExpressionWithPrelude(
        "declare const user: { id: string; name: string };",
        '({ ...user, name: "override" })',
      );
      const shape = extractShape(expr);
      expect(shape?.type).toBe("record");
      if (shape?.type === "record") {
        expect(shape.properties.name).toEqual({ type: "text" });
        expect(shape.properties.id).toEqual({ type: "text" });
        expect(shape.spreads).toBeUndefined();
      }
    });

    it("unresolvable spread remains in spreads[]", () => {
      // No declaration for `rest` — the type checker can't expand it, so the
      // spread falls through to the escape hatch.
      expect(
        extractShape(parseExpression("({ ...rest, admin: true })")),
      ).toEqual({
        type: "record",
        properties: { admin: { type: "boolean" } },
        spreads: [{ sourceText: "rest" }],
      });
    });

    it("spread of typed record merges with explicit property in source order", () => {
      const expr = parseExpressionWithPrelude(
        "declare const defaults: { role: string };\ndeclare const user: { id: string };",
        "({ ...defaults, ...user, admin: true })",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          role: { type: "text" },
          id: { type: "text" },
          admin: { type: "boolean" },
        },
      });
    });
  });
});
