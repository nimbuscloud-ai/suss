import path from "node:path";

import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { parseConditionExpression } from "./predicates.js";

import type { Expression } from "ts-morph";

const FIXTURES_DIR = path.resolve(__dirname, "../../../../fixtures/predicates");

function loadFixture(filename: string) {
  const project = new Project({ useInMemoryFileSystem: false });
  return project.addSourceFileAtPath(path.join(FIXTURES_DIR, filename));
}

/**
 * Get the condition expression from the first IfStatement inside a named function.
 */
function getFirstIfCondition(
  sourceFile: ReturnType<typeof loadFixture>,
  funcName: string,
): Expression {
  const decl = sourceFile.getFunction(funcName);
  if (decl === undefined) {
    throw new Error(`Function "${funcName}" not found`);
  }
  const ifStmt = decl.getDescendantsOfKind(SyntaxKind.IfStatement)[0];
  if (ifStmt === undefined) {
    throw new Error(`No if statement found in "${funcName}"`);
  }
  return ifStmt.getExpression();
}

const sourceFile = loadFixture("fixture-predicates.ts");

// ---------------------------------------------------------------------------
// Truthiness checks
// ---------------------------------------------------------------------------

describe("parseConditionExpression — truthinessCheck", () => {
  it("identifier x → truthinessCheck { subject: input, negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTruthinessId");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    });
  });

  it("property access user.isActive → truthinessCheck", () => {
    const cond = getFirstIfCondition(sourceFile, "checkPropertyAccess");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "input", inputRef: "user", path: [] },
        derivation: { type: "propertyAccess", property: "isActive" },
      },
      negated: false,
    });
  });

  it("element access arr[0] → truthinessCheck", () => {
    const cond = getFirstIfCondition(sourceFile, "checkElementAccess");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "input", inputRef: "arr", path: [] },
        derivation: { type: "indexAccess", index: "0" },
      },
      negated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Negation (!x) — flips negated on truthinessCheck
// ---------------------------------------------------------------------------

describe("parseConditionExpression — negation (!x)", () => {
  it("!x → truthinessCheck { negated: true }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNegationId");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: true,
    });
  });

  it("!!x → truthinessCheck { negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkDoubleNegation");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    });
  });

  it("!user.isActive → truthinessCheck { negated: true }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNegatedPropertyAccess");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "input", inputRef: "user", path: [] },
        derivation: { type: "propertyAccess", property: "isActive" },
      },
      negated: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Null checks
// ---------------------------------------------------------------------------

describe("parseConditionExpression — nullCheck", () => {
  it("x === null → nullCheck { negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkStrictNullEq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    });
  });

  it("x !== null → nullCheck { negated: true }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkStrictNullNeq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: true,
    });
  });

  it("x === undefined → nullCheck { negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkStrictUndefinedEq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    });
  });

  it("x == null → nullCheck { negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkLooseNullEq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    });
  });

  it("x != null → nullCheck { negated: true }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkLooseNullNeq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: true,
    });
  });

  it("!(user === null) → nullCheck { negated: true }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNegatedNullCheck");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "user", path: [] },
      negated: true,
    });
  });

  it("!(user !== null) → nullCheck { negated: false }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNegatedNullNeq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "nullCheck",
      subject: { type: "input", inputRef: "user", path: [] },
      negated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

describe("parseConditionExpression — comparison", () => {
  it("x > 5 → comparison { op: 'gt' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkGt");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "gt",
      right: { type: "literal", value: 5 },
    });
  });

  it("x >= 5 → comparison { op: 'gte' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkGte");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "gte",
      right: { type: "literal", value: 5 },
    });
  });

  it("x < 5 → comparison { op: 'lt' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkLt");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "lt",
      right: { type: "literal", value: 5 },
    });
  });

  it("x <= 5 → comparison { op: 'lte' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkLte");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "lte",
      right: { type: "literal", value: 5 },
    });
  });

  it("x === 'hello' (non-null string) → comparison { op: 'eq' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkStrEq");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "eq",
      right: { type: "literal", value: "hello" },
    });
  });

  it("x === 5 (non-null number) → comparison { op: 'eq' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNonNullComparison");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "eq",
      right: { type: "literal", value: 5 },
    });
  });
});

// ---------------------------------------------------------------------------
// typeCheck (typeof x === "string")
// ---------------------------------------------------------------------------

describe("parseConditionExpression — typeCheck", () => {
  it("typeof x === 'string' → typeCheck { expectedType: 'string' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTypeof");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "typeCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      expectedType: "string",
    });
  });
});

// ---------------------------------------------------------------------------
// Compound: && and ||
// ---------------------------------------------------------------------------

describe("parseConditionExpression — compound", () => {
  it("x && y → compound { op: 'and', operands: [truthiness(x), truthiness(y)] }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkAnd");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "x", path: [] },
          negated: false,
        },
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "y", path: [] },
          negated: false,
        },
      ],
    });
  });

  it("x || y → compound { op: 'or', operands: [truthiness(x), truthiness(y)] }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkOr");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "or",
      operands: [
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "x", path: [] },
          negated: false,
        },
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "y", path: [] },
          negated: false,
        },
      ],
    });
  });

  it("a && b && c → compound with nested compound on left", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNestedAnd");
    const result = parseConditionExpression(cond);
    // a && b && c parses as (a && b) && c
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "a", path: [] },
              negated: false,
            },
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "b", path: [] },
              negated: false,
            },
          ],
        },
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "c", path: [] },
          negated: false,
        },
      ],
    });
  });

  it("x && new Error() → compound with opaque right operand (wrapOpaque fallback)", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const tmpFile = project.createSourceFile(
      "__tmp_opaque_compound.ts",
      "export function f(x: any) { if (x && new Error()) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "x", path: [] },
          negated: false,
        },
        {
          type: "opaque",
          sourceText: "new Error()",
          reason: "complexExpression",
        },
      ],
    });
  });

  it("isActive(user) && isValid → compound with call on left", () => {
    const cond = getFirstIfCondition(sourceFile, "checkAndWithCall");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "call",
          callee: "isActive",
          args: [{ type: "input", inputRef: "user", path: [] }],
        },
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "isValid", path: [] },
          negated: false,
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Call expression
// ---------------------------------------------------------------------------

describe("parseConditionExpression — call", () => {
  it("isActive(user) → call { callee: 'isActive', args: [input(user)] }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkCallExpr");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "call",
      callee: "isActive",
      args: [{ type: "input", inputRef: "user", path: [] }],
    });
  });
});

// ---------------------------------------------------------------------------
// typeof standalone → null
// ---------------------------------------------------------------------------

describe("parseConditionExpression — typeof standalone returns null", () => {
  it("standalone typeof expression → null", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const tmpFile = project.createSourceFile(
      "__tmp_typeof_standalone.ts",
      "export function f(x: any) { if (typeof x) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = parseConditionExpression(cond);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unknown / complex node → null
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Additional typeof variants
// ---------------------------------------------------------------------------

describe("parseConditionExpression — typeof variants", () => {
  it("typeof x === 'number' → typeCheck { expectedType: 'number' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTypeofNumber");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "typeCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      expectedType: "number",
    });
  });

  it("typeof x === 'boolean' → typeCheck { expectedType: 'boolean' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTypeofBoolean");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "typeCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      expectedType: "boolean",
    });
  });

  it("typeof x === 'function' → typeCheck { expectedType: 'function' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTypeofFunction");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "typeCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      expectedType: "function",
    });
  });

  it("'string' === typeof x (reversed) → typeCheck { expectedType: 'string' }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkTypeofReversed");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "typeCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      expectedType: "string",
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-arg calls and complex compounds
// ---------------------------------------------------------------------------

describe("parseConditionExpression — multi-arg calls", () => {
  it("compare(a, b) → call with 2 args", () => {
    const cond = getFirstIfCondition(sourceFile, "checkMultiArgCall");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "call",
      callee: "compare",
      args: [
        { type: "input", inputRef: "a", path: [] },
        { type: "input", inputRef: "b", path: [] },
      ],
    });
  });
});

describe("parseConditionExpression — comparison with non-literal right", () => {
  it("x > y → comparison { left: input(x), right: input(y) }", () => {
    const cond = getFirstIfCondition(sourceFile, "checkComparisonBothParams");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: { type: "input", inputRef: "x", path: [] },
      op: "gt",
      right: { type: "input", inputRef: "y", path: [] },
    });
  });
});

describe("parseConditionExpression — deeply nested compound", () => {
  it("(a && b) || (c && d) → compound(or, [compound(and, ...), compound(and, ...)])", () => {
    const cond = getFirstIfCondition(sourceFile, "checkMixedCompound");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "or",
      operands: [
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "a", path: [] },
              negated: false,
            },
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "b", path: [] },
              negated: false,
            },
          ],
        },
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "c", path: [] },
              negated: false,
            },
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "d", path: [] },
              negated: false,
            },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Unknown / complex node → null
// ---------------------------------------------------------------------------

describe("parseConditionExpression — unknown nodes return null", () => {
  it("new expression condition → null", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const tmpFile = project.createSourceFile(
      "__tmp_newexpr.ts",
      "export function f(x: any) { if (new Error()) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = parseConditionExpression(cond);
    expect(result).toBeNull();
  });

  it("non-! prefix unary operator (-x) → null", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const tmpFile = project.createSourceFile(
      "__tmp_negnum.ts",
      "export function f(x: number) { if (-x) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = parseConditionExpression(cond);
    expect(result).toBeNull();
  });

  it("unsupported binary operator (instanceof) → null", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const tmpFile = project.createSourceFile(
      "__tmp_instanceof.ts",
      "export function f(x: any) { if (x instanceof Error) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = parseConditionExpression(cond);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Call inlining — resolving through local function bodies
// ---------------------------------------------------------------------------

describe("parseConditionExpression — call inlining", () => {
  it("inlines arrow function with expression body: isDeleted(user) → truthinessCheck(user.deletedAt)", () => {
    const cond = getFirstIfCondition(sourceFile, "checkInlineArrow");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "input", inputRef: "user", path: [] },
        derivation: { type: "propertyAccess", property: "deletedAt" },
      },
      negated: false,
    });
  });

  it("inlines negation: isNotActive(user) → truthinessCheck(user.active, negated: true)", () => {
    const cond = getFirstIfCondition(sourceFile, "checkInlineNegation");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "input", inputRef: "user", path: [] },
        derivation: { type: "propertyAccess", property: "active" },
      },
      negated: true,
    });
  });

  it("inlines compound: isAdminAndActive(user) → compound(and, [comparison, truthiness])", () => {
    const cond = getFirstIfCondition(sourceFile, "checkInlineCompound");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "role" },
          },
          op: "eq",
          right: { type: "literal", value: "admin" },
        },
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "active" },
          },
          negated: false,
        },
      ],
    });
  });

  it("inlines function declaration with multi-arg substitution: hasPermission(user, 'admin')", () => {
    const cond = getFirstIfCondition(sourceFile, "checkInlineDeclaration");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "input", inputRef: "user", path: [] },
        derivation: { type: "propertyAccess", property: "role" },
      },
      op: "eq",
      right: { type: "literal", value: "admin" },
    });
  });

  it("does NOT inline multi-return functions (stays opaque call)", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNoInlineMultiReturn");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "call",
      callee: "complexCheck",
      args: [{ type: "input", inputRef: "user", path: [] }],
    });
  });

  it("does NOT inline declared-only functions (stays opaque call)", () => {
    // isActive is `declare function` — no body to inline
    const cond = getFirstIfCondition(sourceFile, "checkCallExpr");
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "call",
      callee: "isActive",
      args: [{ type: "input", inputRef: "user", path: [] }],
    });
  });

  it("inlines both sides of a compound: isDeleted(user) && isVerified(user)", () => {
    const cond = getFirstIfCondition(
      sourceFile,
      "checkInlineCompoundBothSides",
    );
    const result = parseConditionExpression(cond);
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "deletedAt" },
          },
          negated: false,
        },
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "emailVerified" },
          },
          negated: false,
        },
      ],
    });
  });

  it("recursively inlines nested calls: isUsable calls isDeleted and isVerified", () => {
    const cond = getFirstIfCondition(sourceFile, "checkNestedInline");
    const result = parseConditionExpression(cond);
    // isUsable = (u) => !isDeleted(u) && isVerified(u)
    // isDeleted = (u) => u.deletedAt
    // isVerified = (u) => u.emailVerified
    // → compound(and, [truthiness(!user.deletedAt), truthiness(user.emailVerified)])
    expect(result).toEqual({
      type: "compound",
      op: "and",
      operands: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "deletedAt" },
          },
          negated: true,
        },
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "emailVerified" },
          },
          negated: false,
        },
      ],
    });
  });

  it("deeply inlines: canAccess calls hasRole, multi-arg substitution at each level", () => {
    const cond = getFirstIfCondition(sourceFile, "checkDeepInline");
    const result = parseConditionExpression(cond);
    // canAccess = (u, resourceOwnerId) => hasRole(u, "admin") || u.id === resourceOwnerId
    // hasRole = (u, role) => u.role === role
    // → compound(or, [comparison(user.role, eq, "admin"), comparison(user.id, eq, ownerId)])
    expect(result).toEqual({
      type: "compound",
      op: "or",
      operands: [
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "role" },
          },
          op: "eq",
          right: { type: "literal", value: "admin" },
        },
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "input", inputRef: "user", path: [] },
            derivation: { type: "propertyAccess", property: "id" },
          },
          op: "eq",
          right: { type: "input", inputRef: "ownerId", path: [] },
        },
      ],
    });
  });
});
