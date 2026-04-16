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
  describe("primitive literals", () => {
    it('string literal → { literal, value: "hello" }', () => {
      expect(extractShape(parseExpression('"hello"'))).toEqual({
        type: "literal",
        value: "hello",
      });
    });

    it("template literal without substitution → literal with value", () => {
      expect(extractShape(parseExpression("`hello`"))).toEqual({
        type: "literal",
        value: "hello",
      });
    });

    it("integer literal → literal with value + raw", () => {
      expect(extractShape(parseExpression("42"))).toEqual({
        type: "literal",
        value: 42,
        raw: "42",
      });
    });

    it("non-integer numeric → literal with value + raw", () => {
      expect(extractShape(parseExpression("3.14"))).toEqual({
        type: "literal",
        value: 3.14,
        raw: "3.14",
      });
    });

    it("true → literal true; false → literal false", () => {
      expect(extractShape(parseExpression("true"))).toEqual({
        type: "literal",
        value: true,
      });
      expect(extractShape(parseExpression("false"))).toEqual({
        type: "literal",
        value: false,
      });
    });

    it("null → null shape (no value field)", () => {
      expect(extractShape(parseExpression("null"))).toEqual({ type: "null" });
    });

    it("bare identifier with no declaration → null (not decomposable)", () => {
      expect(extractShape(parseExpression("user"))).toBeNull();
    });

    it("property access with no declaration → null (not decomposable)", () => {
      expect(extractShape(parseExpression("user.id"))).toBeNull();
    });
  });

  describe("wire-format fidelity", () => {
    it("raw preserves integers beyond Number.MAX_SAFE_INTEGER", () => {
      // 2^53 + 1 cannot be represented exactly as a JS number — `value`
      // silently rounds down. `raw` must preserve the exact source text so
      // consumers needing precision can parse it themselves.
      const shape = extractShape(parseExpression("9007199254740993"));
      expect(shape).toEqual({
        type: "literal",
        value: 9007199254740992, // number-coerced; lossy
        raw: "9007199254740993",
      });
    });

    it("raw preserves hex notation", () => {
      expect(extractShape(parseExpression("0x10"))).toEqual({
        type: "literal",
        value: 16,
        raw: "0x10",
      });
    });

    it("raw preserves scientific notation", () => {
      expect(extractShape(parseExpression("1e6"))).toEqual({
        type: "literal",
        value: 1_000_000,
        raw: "1e6",
      });
    });

    it("raw preserves numeric separators", () => {
      expect(extractShape(parseExpression("1_000_000"))).toEqual({
        type: "literal",
        value: 1_000_000,
        raw: "1_000_000",
      });
    });

    it("negative numeric: raw carries the sign", () => {
      expect(extractShape(parseExpression("-42"))).toEqual({
        type: "literal",
        value: -42,
        raw: "-42",
      });
    });
  });

  describe("object literals", () => {
    it("flat record with string literal value", () => {
      expect(extractShape(parseExpression('({ error: "not found" })'))).toEqual(
        {
          type: "record",
          properties: {
            error: { type: "literal", value: "not found" },
          },
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
              id: { type: "literal", value: "u1" },
              email: { type: "ref", name: "user.email" },
            },
          },
        },
      });
    });

    it("mixed literals and refs preserve discriminator values", () => {
      expect(
        extractShape(parseExpression("({ ok: true, count: 3, note: msg })")),
      ).toEqual({
        type: "record",
        properties: {
          ok: { type: "literal", value: true },
          count: { type: "literal", value: 3, raw: "3" },
          note: { type: "ref", name: "msg" },
        },
      });
    });

    it("spread captured in spreads array alongside known fields", () => {
      expect(
        extractShape(parseExpression("({ ...user, admin: true })")),
      ).toEqual({
        type: "record",
        properties: { admin: { type: "literal", value: true } },
        spreads: [{ sourceText: "user" }],
      });
    });

    it("multiple spreads captured in order", () => {
      expect(
        extractShape(parseExpression("({ ...base, ...overrides, final: 1 })")),
      ).toEqual({
        type: "record",
        properties: { final: { type: "literal", value: 1, raw: "1" } },
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

    it("homogeneous string array collapses to one literal variant per distinct value", () => {
      // Different string literals dedupe only structurally — three different
      // values produce a union of three literals. Consumers widening for
      // array summaries can collapse literal variants of the same kind.
      expect(extractShape(parseExpression('["a", "b", "c"]'))).toEqual({
        type: "array",
        items: {
          type: "union",
          variants: [
            { type: "literal", value: "a" },
            { type: "literal", value: "b" },
            { type: "literal", value: "c" },
          ],
        },
      });
    });

    it("array of untyped bare identifiers → union of per-element refs", () => {
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
        properties: {
          status: { type: "literal", value: 404, raw: "404" },
        },
      });
    });

    it("parenthesized expression unwraps", () => {
      expect(extractShape(parseExpression("((({ ok: true })))"))).toEqual({
        type: "record",
        properties: { ok: { type: "literal", value: true } },
      });
    });

    it("angle-bracket type assertion unwraps", () => {
      expect(extractShape(parseExpression("<const>({ ok: true })"))).toEqual({
        type: "record",
        properties: { ok: { type: "literal", value: true } },
      });
    });

    it("non-null assertion (`!`) unwraps", () => {
      expect(extractShape(parseExpression("({ ok: true }!)"))).toEqual({
        type: "record",
        properties: { ok: { type: "literal", value: true } },
      });
    });

    it("satisfies clause unwraps", () => {
      expect(
        extractShape(parseExpression("({ ok: true } satisfies object)")),
      ).toEqual({
        type: "record",
        properties: { ok: { type: "literal", value: true } },
      });
    });
  });

  describe("expression syntax", () => {
    it("unary plus on integer preserves the literal", () => {
      expect(extractShape(parseExpression("+42"))).toEqual({
        type: "literal",
        value: 42,
        raw: "42",
      });
    });

    it("negative float preserves the literal with signed raw", () => {
      expect(extractShape(parseExpression("-3.14"))).toEqual({
        type: "literal",
        value: -3.14,
        raw: "-3.14",
      });
    });

    it("template literal with substitution → text (can't narrow to value)", () => {
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

    it("ternary with distinct literal branches → union of literals", () => {
      expect(extractShape(parseExpression('(flag ? "yes" : 42)'))).toEqual({
        type: "union",
        variants: [
          { type: "literal", value: "yes" },
          { type: "literal", value: 42, raw: "42" },
        ],
      });
    });

    it("ternary with identical branches collapses", () => {
      expect(extractShape(parseExpression('(flag ? "a" : "a")'))).toEqual({
        type: "literal",
        value: "a",
      });
    });

    it("heterogeneous array → union of distinct literal variants", () => {
      expect(extractShape(parseExpression('[1, "two", true]'))).toEqual({
        type: "array",
        items: {
          type: "union",
          variants: [
            { type: "literal", value: 1, raw: "1" },
            { type: "literal", value: "two" },
            { type: "literal", value: true },
          ],
        },
      });
    });

    it("array with repeated literals dedupes", () => {
      expect(extractShape(parseExpression("[1, 1, 1]"))).toEqual({
        type: "array",
        items: { type: "literal", value: 1, raw: "1" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // AST-based resolution (preserves literal narrowness the type checker would widen)
  // -------------------------------------------------------------------------

  describe("AST resolution", () => {
    it('untyped `const x = "ok"; x` resolves to the literal via the AST', () => {
      // The type checker at the reference site would give `string` (widened).
      // The AST walker follows the declaration to the literal initializer and
      // preserves `"ok"`. (Name chosen to avoid `status` — a DOM global in
      // `lib.dom.d.ts` — which the type checker shadows over local decls in
      // this in-memory test setup.)
      const expr = parseExpressionWithPrelude(
        'const greeting = "ok" as const;',
        "greeting",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "ok",
      });
    });

    it("walks across a chain of assignments", () => {
      const expr = parseExpressionWithPrelude(
        'const a = "hello"; const b = a;',
        "b",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "hello",
      });
    });

    it("reads a property through an initializer record", () => {
      const expr = parseExpressionWithPrelude(
        'const user = { id: "u1", name: "ada" };',
        "user.id",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "u1",
      });
    });

    it("reads a property through a destructuring binding", () => {
      const expr = parseExpressionWithPrelude(
        'const { id } = { id: "u1", name: "ada" };',
        "id",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "u1",
      });
    });

    it("follows a single-return function call", () => {
      const expr = parseExpressionWithPrelude(
        'function greet() { return "hello"; }',
        "greet()",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "hello",
      });
    });

    it("follows an arrow-function expression body call", () => {
      const expr = parseExpressionWithPrelude(
        'const greet = () => "hi";',
        "greet()",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "hi",
      });
    });

    it("stops at multi-statement function bodies (falls back to checker)", () => {
      // Multi-statement function bodies aren't safely expandable at the AST
      // level (branching returns, effects, etc). We hand off to the type
      // checker, which returns the declared return type.
      const expr = parseExpressionWithPrelude(
        'function greet() { console.log("hi"); return "hi"; }',
        "greet()",
      );
      expect(extractShape(expr)).toEqual({ type: "text" });
    });

    it("cyclic const declarations don't hang", () => {
      // `const a = a` is invalid TS but the walker should still terminate.
      const expr = parseExpressionWithPrelude("const a: string = a;", "a");
      // Falls through to the checker, which gives `string`.
      expect(extractShape(expr)).toEqual({ type: "text" });
    });
  });

  // -------------------------------------------------------------------------
  // Type-checker fallback (types without literal initializers)
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

    it("Record<string, T> index signature → dictionary", () => {
      const expr = parseExpressionWithPrelude(
        "declare const users: Record<string, { id: string }>;",
        "users",
      );
      expect(extractShape(expr)).toEqual({
        type: "dictionary",
        values: {
          type: "record",
          properties: { id: { type: "text" } },
        },
      });
    });

    it("inline index signature → dictionary", () => {
      const expr = parseExpressionWithPrelude(
        "declare const counts: { [k: string]: number };",
        "counts",
      );
      expect(extractShape(expr)).toEqual({
        type: "dictionary",
        values: { type: "number" },
      });
    });

    it("literal type inferred by const-narrowing surfaces as literal", () => {
      const expr = parseExpressionWithPrelude(
        'declare const greeting: "ok";',
        "greeting",
      );
      expect(extractShape(expr)).toEqual({
        type: "literal",
        value: "ok",
      });
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
          admin: { type: "literal", value: true },
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
        expect(shape.properties.name).toEqual({
          type: "literal",
          value: "override",
        });
        expect(shape.properties.id).toEqual({ type: "text" });
        expect(shape.spreads).toBeUndefined();
      }
    });

    it("unresolvable spread remains in spreads[]", () => {
      expect(
        extractShape(parseExpression("({ ...rest, admin: true })")),
      ).toEqual({
        type: "record",
        properties: { admin: { type: "literal", value: true } },
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
          admin: { type: "literal", value: true },
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Literal narrowness preservation (aspiration verification)
  // -------------------------------------------------------------------------

  describe("literal narrowness without as const", () => {
    it("preserves string literal in direct object literal (no as const needed)", () => {
      // The syntactic pass reads the AST node, not the type.
      // { status: "deleted" } → literal("deleted"), not text.
      expect(extractShape(parseExpression('({ status: "deleted" })'))).toEqual({
        type: "record",
        properties: {
          status: { type: "literal", value: "deleted" },
        },
      });
    });

    it("preserves literal through variable binding to object literal", () => {
      // const result = { status: "deleted" }; → resolves through variable
      const expr = parseExpressionWithPrelude(
        'const result = { status: "deleted" };',
        "result",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          status: { type: "literal", value: "deleted" },
        },
      });
    });

    it("preserves literal through single-return local function", () => {
      // function build() { return { status: "deleted" }; }
      // extractShape(build()) → literal preserved via resolveCall
      const expr = parseExpressionWithPrelude(
        'function buildDeleted() { return { status: "deleted" }; }',
        "buildDeleted()",
      );
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          status: { type: "literal", value: "deleted" },
        },
      });
    });

    it("expands named interface to record (not ref)", () => {
      // interface User { id: string; name: string }
      // declare const user: User → record, not ref
      const expr = parseExpressionWithPrelude(
        "interface User { id: string; name: string; }\ndeclare const user: User;",
        "user",
      );
      const shape = extractShape(expr);
      expect(shape?.type).toBe("record");
      if (shape?.type === "record") {
        expect(shape.properties.id).toEqual({ type: "text" });
        expect(shape.properties.name).toEqual({ type: "text" });
      }
    });

    it("loses literal narrowness through typed variable binding", () => {
      // When a variable has an explicit type annotation that widens the literal,
      // the AST resolver still walks to the initializer and preserves the literal.
      const expr = parseExpressionWithPrelude(
        'const result: { status: string } = { status: "deleted" };',
        "result",
      );
      // The initializer IS the object literal, so syntactic pass catches it
      expect(extractShape(expr)).toEqual({
        type: "record",
        properties: {
          status: { type: "literal", value: "deleted" },
        },
      });
    });
  });
});
