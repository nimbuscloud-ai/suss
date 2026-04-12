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
