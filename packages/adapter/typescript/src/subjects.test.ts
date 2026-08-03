import path from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject, testCompilerOptions } from "@suss/test-project";

import { resolveSubject } from "./subjects.js";

import type { Expression } from "ts-morph";

const FIXTURES_DIR = path.resolve(__dirname, "../../../../fixtures/subjects");

// One project for every fixture in this file. Each fixture has its own
// path, so nothing here collides.
const fixtures = new Project({ compilerOptions: testCompilerOptions });

function loadFixture(filename: string) {
  return fixtures.addSourceFileAtPath(path.join(FIXTURES_DIR, filename));
}

/**
 * Get the condition expression from the first IfStatement inside a named function.
 * This is the expression used as the if-condition.
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

/**
 * Get the first BinaryExpression's left and right sub-expressions from a function.
 */
function getBinaryExprParts(
  sourceFile: ReturnType<typeof loadFixture>,
  funcName: string,
): { left: Expression; right: Expression } {
  const condition = getFirstIfCondition(sourceFile, funcName);
  if (!Node.isBinaryExpression(condition)) {
    throw new Error(`Expected BinaryExpression in "${funcName}"`);
  }
  return { left: condition.getLeft(), right: condition.getRight() };
}

const sourceFile = loadFixture("fixture-subjects.ts");

// ---------------------------------------------------------------------------
// Parameter → input
// ---------------------------------------------------------------------------

describe("resolveSubject — parameter identifier", () => {
  it("simple param resolves to input", () => {
    const cond = getFirstIfCondition(sourceFile, "paramSimple");
    const result = resolveSubject(cond);
    expect(result).toEqual({ type: "input", inputRef: "userId", path: [] });
  });

  it("param.property resolves to derived(input, propertyAccess)", () => {
    // req.user.id — outermost expression is elementAccess chain
    const condition = getFirstIfCondition(sourceFile, "paramPropertyAccess");
    const result = resolveSubject(condition);
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "derived",
        from: { type: "input", inputRef: "req", path: [] },
        derivation: { type: "propertyAccess", property: "user" },
      },
      derivation: { type: "propertyAccess", property: "id" },
    });
  });
});

// ---------------------------------------------------------------------------
// Local variable from call → dependency
// ---------------------------------------------------------------------------

describe("resolveSubject — local variable from call", () => {
  it("const user = db.findUser(id) → dependency", () => {
    const cond = getFirstIfCondition(sourceFile, "localFromCall");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "dependency",
      name: "db.findUser",
      accessChain: [],
    });
  });

  it("const user = await db.findUser(id) → dependency (unwrap await)", () => {
    const cond = getFirstIfCondition(sourceFile, "localFromAwaitCall");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "dependency",
      name: "db.findUser",
      accessChain: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Destructured from await call → derived
// ---------------------------------------------------------------------------

describe("resolveSubject — destructured binding", () => {
  it("const { user } = await db.findUser(id) → derived(dependency, destructured)", () => {
    const cond = getFirstIfCondition(sourceFile, "destructuredFromAwait");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "derived",
      from: { type: "dependency", name: "db.findUser", accessChain: [] },
      derivation: { type: "destructured", field: "user" },
    });
  });

  it("const { token } = getAuth(req) → derived(dependency, destructured)", () => {
    const cond = getFirstIfCondition(sourceFile, "destructuredFromCall");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "derived",
      from: { type: "dependency", name: "getAuth", accessChain: [] },
      derivation: { type: "destructured", field: "token" },
    });
  });
});

// ---------------------------------------------------------------------------
// Element access → derived(indexAccess)
// ---------------------------------------------------------------------------

describe("resolveSubject — element access", () => {
  it("arr[0] → derived(input, indexAccess(0)) with a numeric index value", () => {
    const cond = getFirstIfCondition(sourceFile, "elementAccess");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "derived",
      from: { type: "input", inputRef: "arr", path: [] },
      derivation: { type: "indexAccess", index: 0 },
    });
  });

  it('obj["role"] → indexAccess("role") — literal value, not quoted source text', () => {
    const cond = getFirstIfCondition(sourceFile, "elementAccessStringLiteral");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "derived",
      from: { type: "input", inputRef: "obj", path: [] },
      derivation: { type: "indexAccess", index: "role" },
    });
  });

  it("obj[key] with a variable index → unresolved, never a fabricated static index", () => {
    // A dynamic index is not a static property read; encoding the
    // identifier text as the index would make `obj[key]` claim to be
    // `obj["key"]` — a false condition downstream.
    const cond = getFirstIfCondition(sourceFile, "elementAccessDynamic");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "unresolved",
      sourceText: "obj[key]",
    });
  });
});

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

describe("resolveSubject — literals", () => {
  it("numeric literal 5 → { type: literal, value: 5 }", () => {
    const { right } = getBinaryExprParts(sourceFile, "numericLiteral");
    const result = resolveSubject(right);
    expect(result).toEqual({ type: "literal", value: 5 });
  });

  it("string literal 'hello' → { type: literal, value: 'hello' }", () => {
    const { right } = getBinaryExprParts(sourceFile, "stringLiteral");
    const result = resolveSubject(right);
    expect(result).toEqual({ type: "literal", value: "hello" });
  });

  it("null keyword → { type: literal, value: null }", () => {
    const { right } = getBinaryExprParts(sourceFile, "nullKeyword");
    const result = resolveSubject(right);
    expect(result).toEqual({ type: "literal", value: null });
  });

  it("undefined identifier → { type: literal, value: null }", () => {
    // We need an expression that has `undefined` in it. Use a function whose
    // condition is `x === undefined`. Get the right side.
    const project = createTestProject();
    const tmpFile = project.createSourceFile(
      "__tmp_undefined.ts",
      "export function f(x: any) { if (x === undefined) return 1; }",
    );
    const ifExpr = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    if (!Node.isBinaryExpression(ifExpr)) {
      throw new Error("expected binary");
    }
    const result = resolveSubject(ifExpr.getRight());
    expect(result).toEqual({ type: "literal", value: null });
  });

  it("true keyword → { type: literal, value: true }", () => {
    const project = createTestProject();
    const tmpFile = project.createSourceFile(
      "__tmp_bool.ts",
      "export function f(x: any) { if (x === true) return 1; }",
    );
    const ifExpr = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    if (!Node.isBinaryExpression(ifExpr)) {
      throw new Error("expected binary");
    }
    const result = resolveSubject(ifExpr.getRight());
    expect(result).toEqual({ type: "literal", value: true });
  });

  it("false keyword → { type: literal, value: false }", () => {
    const project = createTestProject();
    const tmpFile = project.createSourceFile(
      "__tmp_false.ts",
      "export function f(x: any) { if (x === false) return 1; }",
    );
    const ifExpr = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    if (!Node.isBinaryExpression(ifExpr)) {
      throw new Error("expected binary");
    }
    const result = resolveSubject(ifExpr.getRight());
    expect(result).toEqual({ type: "literal", value: false });
  });
});

// ---------------------------------------------------------------------------
// Deep property chain
// ---------------------------------------------------------------------------

describe("resolveSubject — deep property chain", () => {
  it("req.body.user.id → nested derived chain", () => {
    const cond = getFirstIfCondition(sourceFile, "deepPropertyChain");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "derived",
        from: {
          type: "derived",
          from: { type: "input", inputRef: "req", path: [] },
          derivation: { type: "propertyAccess", property: "body" },
        },
        derivation: { type: "propertyAccess", property: "user" },
      },
      derivation: { type: "propertyAccess", property: "id" },
    });
  });
});

// ---------------------------------------------------------------------------
// Unresolved
// ---------------------------------------------------------------------------

describe("resolveSubject — unresolved", () => {
  it("arrow function expression → unresolved", () => {
    const project = createTestProject();
    const tmpFile = project.createSourceFile(
      "__tmp_unresolved.ts",
      "export function f() { const fn = () => 1; if (fn()) return 1; }",
    );
    // Get the if condition expression: fn() is a CallExpression whose expression is fn (Identifier)
    // fn is a local variable holding an arrow function (not a call init) → unresolved
    const ifExpr = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    // ifExpr is a CallExpression: fn()
    // We want to resolve the callee identifier fn which has an arrow function initializer
    if (!Node.isCallExpression(ifExpr)) {
      throw new Error("expected call expression");
    }
    const calleeExpr = ifExpr.getExpression();
    const result = resolveSubject(calleeExpr);
    // fn is declared with an arrow function initializer, which is not a CallExpression → unresolved
    expect(result).toEqual({ type: "unresolved", sourceText: "fn" });
  });

  it("unknown expression kind → unresolved", () => {
    const project = createTestProject();
    const tmpFile = project.createSourceFile(
      "__tmp_newexpr2.ts",
      "export function f(x: any) { if (new Error()) return 1; }",
    );
    const cond = tmpFile
      .getFunctions()[0]
      .getDescendantsOfKind(SyntaxKind.IfStatement)[0]
      .getExpression();
    const result = resolveSubject(cond);
    expect(result.type).toBe("unresolved");
  });
});

// ---------------------------------------------------------------------------
// Parenthesized and as-expression (strip)
// ---------------------------------------------------------------------------

describe("resolveSubject — transparent nodes", () => {
  it("parenthesized expression resolves inner", () => {
    const cond = getFirstIfCondition(sourceFile, "parenthesized");
    const result = resolveSubject(cond);
    expect(result).toEqual({ type: "input", inputRef: "x", path: [] });
  });
});

// ---------------------------------------------------------------------------
// Deep dependency chains
// ---------------------------------------------------------------------------

describe("resolveSubject — deep dependency chain", () => {
  it("services.db.users.findUser(id) → dependency with deep callee name", () => {
    const cond = getFirstIfCondition(sourceFile, "deepDependencyChain");
    const result = resolveSubject(cond);
    expect(result).toEqual({
      type: "dependency",
      name: "services.db.users.findUser",
      accessChain: [],
    });
  });
});

describe("resolveSubject — dependency then property access", () => {
  it("db.findUser(id) then .name → derived(dependency, propertyAccess)", () => {
    const cond = getFirstIfCondition(sourceFile, "dependencyThenProperty");
    const result = resolveSubject(cond);
    // user.name → user is dependency(db.findUser), .name is propertyAccess
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "dependency",
        name: "db.findUser",
        accessChain: [],
      },
      derivation: { type: "propertyAccess", property: "name" },
    });
  });
});

// ---------------------------------------------------------------------------
// Intermediate variable resolution (Level 4)
// ---------------------------------------------------------------------------

describe("resolveSubject — intermediate variable assignments", () => {
  it("const data = result.body; data.name → derived chain through intermediate", () => {
    const cond = getFirstIfCondition(sourceFile, "intermediatePropertyAccess");
    const result = resolveSubject(cond);
    // data.name → data = result.body → result = await db.findUser(id)
    // so: derived(derived(dependency(db.findUser), body), name)
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "derived",
        from: {
          type: "dependency",
          name: "db.findUser",
          accessChain: [],
        },
        derivation: { type: "propertyAccess", property: "body" },
      },
      derivation: { type: "propertyAccess", property: "name" },
    });
  });

  it("const alias = user; alias.deletedAt → follows identifier assignment", () => {
    const cond = getFirstIfCondition(sourceFile, "intermediateIdentifier");
    const result = resolveSubject(cond);
    // alias.deletedAt → alias = user → user = await db.findUser(id)
    // so: derived(dependency(db.findUser), deletedAt)
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "dependency",
        name: "db.findUser",
        accessChain: [],
      },
      derivation: { type: "propertyAccess", property: "deletedAt" },
    });
  });

  it("three-level chain: result → body → user → user.name", () => {
    const cond = getFirstIfCondition(sourceFile, "chainedIntermediates");
    const result = resolveSubject(cond);
    // user.name → user = body.user → body = result.body → result = await db.findUser("1")
    // so: derived(derived(derived(dependency(db.findUser), body), user), name)
    expect(result).toEqual({
      type: "derived",
      from: {
        type: "derived",
        from: {
          type: "derived",
          from: {
            type: "dependency",
            name: "db.findUser",
            accessChain: [],
          },
          derivation: { type: "propertyAccess", property: "body" },
        },
        derivation: { type: "propertyAccess", property: "user" },
      },
      derivation: { type: "propertyAccess", property: "name" },
    });
  });
});

// ---------------------------------------------------------------------------
// Promise `.then` / `.catch` parameter binding
// (docs/internal/proposals/adapter-ecmascript-spec.md)
// ---------------------------------------------------------------------------

describe("Promise .then parameter binding", () => {
  function propAccess(source: string, text: string): Expression {
    const project = createTestProject();
    const file = project.createSourceFile("chain.ts", source);
    const found = file
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .find((n) => n.getText() === text);
    if (found === undefined) {
      throw new Error(`property access "${text}" not found`);
    }
    return found;
  }

  it("binds a .then callback param to the upstream call result", () => {
    const source = `
      interface Resp { ok: boolean; }
      declare function fetchUser(): Promise<Resp>;
      function consume() {
        fetchUser().then((res) => {
          if (!res.ok) {
            return;
          }
        });
      }
    `;
    // `res` is the resolved value of `fetchUser()`, not an input.
    expect(resolveSubject(propAccess(source, "res.ok"))).toEqual({
      type: "derived",
      from: { type: "dependency", name: "fetchUser", accessChain: [] },
      derivation: { type: "propertyAccess", property: "ok" },
    });
  });

  it("binds a chained .then param to the previous callback's return value", () => {
    const source = `
      interface Resp { ok: boolean; json(): Promise<{ name: string }>; }
      declare function fetchUser(): Promise<Resp>;
      function consume() {
        fetchUser()
          .then((res) => res.json())
          .then((data) => {
            if (!data.name) {
              return;
            }
          });
      }
    `;
    // `data` is the resolved value of the upstream `res.json()`.
    expect(resolveSubject(propAccess(source, "data.name"))).toEqual({
      type: "derived",
      from: { type: "dependency", name: "res.json", accessChain: [] },
      derivation: { type: "propertyAccess", property: "name" },
    });
  });

  it("leaves a non-Promise `.then` receiver param as an input (strict gate)", () => {
    const source = `
      interface Builder { then(cb: (x: { ok: boolean }) => void): void; }
      declare const builder: Builder;
      function consume() {
        builder.then((res) => {
          if (!res.ok) {
            return;
          }
        });
      }
    `;
    // The receiver is a custom thenable, not Promise<T>; strict binding
    // declines and the parameter resolves as an ordinary input.
    expect(resolveSubject(propAccess(source, "res.ok"))).toEqual({
      type: "derived",
      from: { type: "input", inputRef: "res", path: [] },
      derivation: { type: "propertyAccess", property: "ok" },
    });
  });

  it("treats a .catch param's rejected value as opaque", () => {
    const source = `
      declare function fetchUser(): Promise<{ ok: boolean }>;
      function consume() {
        fetchUser().catch((err) => {
          if (err.code) {
            return;
          }
        });
      }
    `;
    expect(resolveSubject(propAccess(source, "err.code"))).toEqual({
      type: "derived",
      from: { type: "unresolved", sourceText: "err" },
      derivation: { type: "propertyAccess", property: "code" },
    });
  });
});
