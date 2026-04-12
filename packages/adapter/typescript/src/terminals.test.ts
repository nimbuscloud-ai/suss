// terminals.test.ts — exhaustive tests for findTerminals (Task 2.3)

import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { findTerminals } from "./terminals.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProject() {
  return new Project({ useInMemoryFileSystem: true });
}

function makeReturnShapePattern(
  requiredProperties?: string[],
): TerminalPattern {
  const matchBase: { type: "returnShape"; requiredProperties?: string[] } = {
    type: "returnShape",
  };
  if (requiredProperties !== undefined) {
    matchBase.requiredProperties = requiredProperties;
  }
  return {
    kind: "response",
    match: matchBase,
    extraction: {
      statusCode: { from: "property", name: "status" },
      body: { from: "property", name: "body" },
    },
  };
}

function makeParamMethodPattern(
  methodChain: string[],
  parameterPosition: number,
): TerminalPattern {
  if (methodChain.length === 1) {
    return {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition,
        methodChain,
      },
      extraction: {
        body: { from: "argument", position: 0 },
      },
    };
  }

  return {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition,
      methodChain,
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  };
}

function makeThrowPattern(constructorPattern?: string): TerminalPattern {
  const matchBase: { type: "throwExpression"; constructorPattern?: string } = {
    type: "throwExpression",
  };
  if (constructorPattern !== undefined) {
    matchBase.constructorPattern = constructorPattern;
  }
  return {
    kind: "throw",
    match: matchBase,
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 1 },
    },
  };
}

// ---------------------------------------------------------------------------
// returnShape — match cases
// ---------------------------------------------------------------------------

describe("returnShape — basic matching", () => {
  it("matches return { status: 200, body: data } with required ['status', 'body']", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        return { status: 200, body: { id: 1 } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ id: 1 }",
      shape: {
        type: "record",
        properties: { id: { type: "integer" } },
      },
    });
  });

  it("matches return { status: 500, body: { message: 'err' } } → literal 500", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        return { status: 500, body: { message: "err" } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 500,
    });
  });

  it("matches return { status: dynamicCode, body: data } → dynamic statusCode", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler(dynamicCode: number) {
        return { status: dynamicCode, body: { id: 1 } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: "dynamicCode",
    });
  });

  it("matches return {} with NO required properties (plain returnShape)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return {};
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeReturnShapePattern()]);

    expect(terminals).toHaveLength(1);
  });

  it("matches shorthand property return { status, body }", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(status: number, body: unknown) {
        return { status, body };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    // shorthand: statusCode should be dynamic with name
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: "status",
    });
  });
});

// ---------------------------------------------------------------------------
// returnShape — arrow expression body (implicit return)
// ---------------------------------------------------------------------------

describe("returnShape — arrow expression body", () => {
  it("matches async () => ({ status: 200, body: {} }) — concise ts-rest form", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = async ({ params }: any) => ({
        status: 200,
        body: { id: params.id },
      });
    `,
    );

    const varDecl = file.getVariableDeclarations()[0];
    const func = varDecl.getInitializerOrThrow() as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ id: params.id }",
      shape: {
        type: "record",
        properties: { id: { type: "ref", name: "params.id" } },
      },
    });
  });

  it("matches concise arrow with dynamic statusCode", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = async (code: number) => ({
        status: code,
        body: { ok: true },
      });
    `,
    );

    const varDecl = file.getVariableDeclarations()[0];
    const func = varDecl.getInitializerOrThrow() as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: "code",
    });
  });

  it("does NOT match nested object inside expression body (only the outer object)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = async () => ({
        status: 200,
        body: { status: 500, body: { nested: true } },
      });
    `,
    );

    const varDecl = file.getVariableDeclarations()[0];
    const func = varDecl.getInitializerOrThrow() as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    // Only the outer object matches, not the inner { status: 500, body: ... }
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("does NOT match arrow expression body when required property missing", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = async () => ({
        status: 200,
      });
    `,
    );

    const varDecl = file.getVariableDeclarations()[0];
    const func = varDecl.getInitializerOrThrow() as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nested function boundary
// ---------------------------------------------------------------------------

describe("nested function boundary", () => {
  it("does NOT find res.json() inside a nested closure", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        const fetchData = () => {
          res.json({ wrong: true });
        };
        res.json({ correct: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeParamMethodPattern(["json"], 1),
    ]);

    // Only the direct call, not the one inside the nested arrow
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ correct: true }",
      shape: {
        type: "record",
        properties: { correct: { type: "boolean" } },
      },
    });
  });

  it("does NOT find return { status, body } inside a nested function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        const inner = async () => {
          return { status: 500, body: { error: "inner" } };
        };
        return { status: 200, body: { ok: true } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("does NOT find throw inside a nested function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        const validator = () => {
          throw new Error("validation failed");
        };
        throw new Error("handler error");
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern()]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.exceptionType).toBe("Error");
  });

  it("does NOT find expression-body returns inside nested .map() arrow", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = async () => ({
        status: 200,
        body: items.map((item: any) => ({ status: 500, body: item })),
      });
    `,
    );

    const varDecl = file.getVariableDeclarations()[0];
    const func = varDecl.getInitializerOrThrow() as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    // Only the outer expression body, not the nested .map() arrow
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// returnShape — non-match cases
// ---------------------------------------------------------------------------

describe("returnShape — non-match cases", () => {
  it("does NOT match when required property 'body' is missing", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        return { status: 200 };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match return data (identifier, not object literal)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        const data = { status: 200, body: {} };
        return data;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match return; (no argument)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match return; even with no required properties", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeReturnShapePattern()]);

    expect(terminals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parameterMethodCall — match cases
// ---------------------------------------------------------------------------

describe("parameterMethodCall — matching", () => {
  it("matches res.json(data) with ['json'] at param 1", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        const data = { users: [] };
        res.json(data);
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeParamMethodPattern(["json"], 1),
    ]);

    expect(terminals).toHaveLength(1);
    // Bare identifier — not a decomposable literal, so shape stays null
    // and the source text is preserved as typeText.
    expect(terminals[0].terminal.body).toEqual({
      typeText: "data",
      shape: null,
    });
  });

  it("matches res.status(200).json(data) with ['status', 'json'] at param 1", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        res.status(200).json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ ok: true }",
      shape: {
        type: "record",
        properties: { ok: { type: "boolean" } },
      },
    });
  });

  it("matches res.status(dynamicCode).json(data) → dynamic statusCode", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any, code: number) {
        res.status(code).json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: "code",
    });
  });

  it("matches res.send('OK') with ['send'] at param 1", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        res.send("OK");
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["send"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
    ]);

    expect(terminals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parameterMethodCall — non-match cases
// ---------------------------------------------------------------------------

describe("parameterMethodCall — non-match cases", () => {
  it("does NOT match res.json(data) with ['status', 'json'] (chain too short)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        res.json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match res.status(200).json(data) with ['json'] only", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        res.status(200).json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    // With only ["json"], the expression of .json() is not an Identifier (it's a CallExpression)
    const terminals = findTerminals(func, [
      makeParamMethodPattern(["json"], 1),
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match req.json(data) where req is at position 0, pattern requires 1", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        req.json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeParamMethodPattern(["json"], 1),
    ]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match someOtherVar.json(data) where someOtherVar is not a parameter", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        const someOtherVar = { json: (x: any) => x };
        someOtherVar.json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeParamMethodPattern(["json"], 1),
    ]);

    expect(terminals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// throwExpression — match cases
// ---------------------------------------------------------------------------

describe("throwExpression — matching", () => {
  it("matches throw new Error('msg') with no constructorPattern", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        throw new Error("msg");
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern()]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.exceptionType).toBe("Error");
  });

  it("matches throw httpErrorJson(404, { message: 'Not found' }) with constructorPattern 'httpErrorJson'", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare function httpErrorJson(status: number, body: unknown): never;
      async function handler() {
        throw httpErrorJson(404, { message: "Not found" });
      }
    `,
    );

    const func = file.getFunctions()[1] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern("httpErrorJson")]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.exceptionType).toBe("httpErrorJson");
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(terminals[0].terminal.body).toEqual({
      typeText: '{ message: "Not found" }',
      shape: {
        type: "record",
        properties: { message: { type: "text" } },
      },
    });
  });

  it("matches throw httpErrorJson(statusCode, body) → dynamic statusCode", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare function httpErrorJson(status: number, body: unknown): never;
      async function handler(statusCode: number, body: unknown) {
        throw httpErrorJson(statusCode, body);
      }
    `,
    );

    const func = file.getFunctions()[1] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern("httpErrorJson")]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: "statusCode",
    });
  });

  it("matches throw new HttpError.NotFound() with constructorPattern 'HttpError'", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        throw new HttpError.NotFound();
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern("HttpError")]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.exceptionType).toBe("HttpError.NotFound");
  });

  it("matches throw error (identifier) with no constructorPattern", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        const error = new Error("oops");
        throw error;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern()]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.exceptionType).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// throwExpression — non-match cases
// ---------------------------------------------------------------------------

describe("throwExpression — non-match cases", () => {
  it("does NOT match throw new Error() with constructorPattern 'httpErrorJson'", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        throw new Error("msg");
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern("httpErrorJson")]);

    expect(terminals).toHaveLength(0);
  });

  it("does NOT match throw error (identifier) when constructorPattern is set", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        const error = new Error("oops");
        throw error;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeThrowPattern("httpErrorJson")]);

    expect(terminals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// returnShape — ternary branches
// ---------------------------------------------------------------------------

describe("returnShape — ternary return branches", () => {
  it("matches both branches of return x ? {...} : {...}", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler() {
        const user = await db.findById(id);
        return user ? { status: 200, body: user } : { status: 404, body: { error: "not found" } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(2);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(terminals[1].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
  });

  it("handles nested ternary: return a ? {...} : b ? {...} : {...}", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return isAdmin
          ? { status: 200, body: { admin: true } }
          : isUser
            ? { status: 200, body: { admin: false } }
            : { status: 403, body: { error: "forbidden" } };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(3);
    const statuses = terminals.map((t) => t.terminal.statusCode);
    expect(statuses).toContainEqual({ type: "literal", value: 200 });
    expect(statuses).toContainEqual({ type: "literal", value: 403 });
  });

  it("matches ternary in arrow expression body: () => (x ? {...} : {...})", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const handler = (user: any) => (user ? { status: 200, body: user } : { status: 404, body: {} });
    `,
    );

    const arrowFn = file
      .getVariableDeclarations()[0]
      .getInitializerIfKindOrThrow(
        SyntaxKind.ArrowFunction,
      ) as unknown as FunctionRoot;
    const terminals = findTerminals(arrowFn, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(2);
  });

  it("does NOT duplicate simple return { ... } (no ternary)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return { status: 200, body: {} };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [makeReturnShapePattern()]);

    // Must be exactly 1, not 2
    expect(terminals).toHaveLength(1);
  });

  it("matches when only one ternary branch is an object literal", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return isOk ? { status: 200, body: data } : null;
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    // Only the object literal branch matches
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// functionCall — matching
// ---------------------------------------------------------------------------

describe("functionCall — matching", () => {
  it("matches json(data) call and extracts body", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function loader() {
        return json({ user: { id: 1 } });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "functionCall", functionName: "json" },
      extraction: { body: { from: "argument", position: 0 } },
    };
    const terminals = findTerminals(func, [pattern]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.kind).toBe("response");
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ user: { id: 1 } }",
      shape: {
        type: "record",
        properties: {
          user: {
            type: "record",
            properties: { id: { type: "integer" } },
          },
        },
      },
    });
  });

  it("matches redirect(url, status) and extracts statusCode", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function loader() {
        return redirect("/login", 301);
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "functionCall", functionName: "redirect" },
      extraction: { statusCode: { from: "argument", position: 1 } },
    };
    const terminals = findTerminals(func, [pattern]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 301,
    });
  });

  it("matches data() call (React Router v7 replacement for json)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function loader() {
        return data({ users: [] });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "functionCall", functionName: "data" },
      extraction: { body: { from: "argument", position: 0 } },
    };
    const terminals = findTerminals(func, [pattern]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.body).toEqual({
      typeText: "{ users: [] }",
      shape: {
        type: "record",
        properties: {
          users: { type: "array", items: { type: "unknown" } },
        },
      },
    });
  });

  it("does not match property access calls (e.g., res.json)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler(req: any, res: any) {
        res.json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "functionCall", functionName: "json" },
      extraction: { body: { from: "argument", position: 0 } },
    };
    const terminals = findTerminals(func, [pattern]);

    // res.json() callee is PropertyAccessExpression, not Identifier — should not match
    expect(terminals).toHaveLength(0);
  });

  it("does not match wrong function name", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function loader() {
        return json({ user: {} });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "functionCall", functionName: "redirect" },
      extraction: {},
    };
    const terminals = findTerminals(func, [pattern]);

    expect(terminals).toHaveLength(0);
  });

  it("finds multiple functionCall terminals in one handler", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function loader({ params }: any) {
        if (!params.id) {
          return redirect("/404");
        }
        const user = await getUser(params.id);
        return json({ user });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const patterns: TerminalPattern[] = [
      {
        kind: "response",
        match: { type: "functionCall", functionName: "json" },
        extraction: { body: { from: "argument", position: 0 } },
      },
      {
        kind: "response",
        match: { type: "functionCall", functionName: "redirect" },
        extraction: {},
      },
    ];
    const terminals = findTerminals(func, patterns);

    expect(terminals).toHaveLength(2);
    const names = terminals.map((t) => {
      const n = t.node;
      return n.getText();
    });
    expect(names.some((n) => n.includes("redirect"))).toBe(true);
    expect(names.some((n) => n.includes("json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple patterns together — realistic handler
// ---------------------------------------------------------------------------

describe("multiple patterns — Express handler with two calls", () => {
  it("finds both res.status(400).json() and res.status(200).json() calls", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function handler(req: any, res: any) {
        if (!req.body.id) {
          res.status(400).json({ error: "missing id" });
          return;
        }
        res.status(200).json({ ok: true });
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition: 1,
        methodChain: ["status", "json"],
      },
      extraction: {
        statusCode: { from: "argument", position: 0 },
        body: { from: "argument", position: 0 },
      },
    };

    const terminals = findTerminals(func, [pattern]);

    expect(terminals).toHaveLength(2);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 400,
    });
    expect(terminals[1].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// Realistic ts-rest handler (from real app pattern)
// ---------------------------------------------------------------------------

describe("realistic ts-rest handler — multiple returns", () => {
  it("finds all 3 returns in a try/catch handler", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function processRepository() {
        try {
          if (!process.env.QUEUE_ID) {
            return { status: 500, body: { message: "missing config" } };
          }
          return { status: 202, body: { taskId: "abc" } };
        } catch (error) {
          return { status: 500, body: { message: String(error) } };
        }
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(3);

    const codes = terminals.map((t) => t.terminal.statusCode);
    expect(codes[0]).toEqual({ type: "literal", value: 500 });
    expect(codes[1]).toEqual({ type: "literal", value: 202 });
    expect(codes[2]).toEqual({ type: "literal", value: 500 });
  });
});

// ---------------------------------------------------------------------------
// first-match-wins (multiple patterns, node matches first)
// ---------------------------------------------------------------------------

describe("first-match-wins per node", () => {
  it("when two patterns would match, only the first is used", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return { status: 200, body: {} };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern1 = makeReturnShapePattern(["status", "body"]);
    const pattern2: TerminalPattern = {
      ...makeReturnShapePattern(),
      kind: "return",
    };

    const terminals = findTerminals(func, [pattern1, pattern2]);

    // Only one match (first pattern wins)
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.kind).toBe("response"); // from pattern1
  });
});

// ---------------------------------------------------------------------------
// Location tracking
// ---------------------------------------------------------------------------

describe("location tracking", () => {
  it("records start and end line numbers", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `function handler() {
  return { status: 200, body: {} };
}`,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const terminals = findTerminals(func, [
      makeReturnShapePattern(["status", "body"]),
    ]);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.location.start).toBeGreaterThanOrEqual(1);
    expect(terminals[0].terminal.location.end).toBeGreaterThanOrEqual(
      terminals[0].terminal.location.start,
    );
  });
});

// ---------------------------------------------------------------------------
// extraction — from: "constructor" maps exception type to status code
// ---------------------------------------------------------------------------

describe("extraction — from: 'constructor'", () => {
  it("resolves a bare constructor name via full-text match", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare class NotFoundError extends Error {}
      function handler() {
        throw new NotFoundError();
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { NotFoundError: 404, BadRequestError: 400 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(terminals[0].terminal.exceptionType).toBe("NotFoundError");
  });

  it("resolves a dotted constructor name via full-text match", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare const HttpError: { NotFound: new () => Error };
      function handler() {
        throw new HttpError.NotFound();
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { "HttpError.NotFound": 404 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
  });

  it("falls back to the last dot-segment when the full name is not mapped", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare const createError: { NotFound: new () => Error };
      function handler() {
        throw new createError.NotFound();
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { NotFound: 404 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
  });

  it("returns null when the constructor name is not in the codes map", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare class WeirdError extends Error {}
      function handler() {
        throw new WeirdError();
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { NotFound: 404, BadRequest: 400 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toBeNull();
    expect(terminals[0].terminal.exceptionType).toBe("WeirdError");
  });

  it("works for throw of a call expression (not just new)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare function notFound(): never;
      function handler() {
        throw notFound();
      }
    `,
    );

    // getFunctions() includes the `declare function`; pick the handler by name.
    const func = file
      .getFunctions()
      .find((f) => f.getName() === "handler") as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { notFound: 404 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
  });

  it("is ignored for non-throw matchers (returnShape, parameterMethodCall, functionCall)", () => {
    // Sanity check: 'constructor' only meaningfully fires for throws, since
    // other matchers don't carry an exception type. A pack that mis-configures
    // this should get null, not spurious status codes.
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return { status: 200 };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "returnShape" },
      extraction: {
        statusCode: {
          from: "constructor",
          codes: { NotFound: 404 },
        },
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toBeNull();
  });
});

describe("extraction edge cases", () => {
  it("throw with property extraction for statusCode returns null (v0 limitation)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare function httpErrorJson(status: number, body: unknown): never;
      function handler() {
        throw httpErrorJson(404, { message: "nope" });
      }
    `,
    );

    const func = file.getFunctions()[1] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "throw",
      match: { type: "throwExpression", constructorPattern: "httpErrorJson" },
      extraction: {
        statusCode: { from: "property", name: "status" }, // not valid for throws, returns null
      },
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toBeNull();
  });

  it("no extraction config → all null", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {
        return { status: 200, body: {} };
      }
    `,
    );

    const func = file.getFunctions()[0] as FunctionRoot;
    const pattern: TerminalPattern = {
      kind: "response",
      match: { type: "returnShape", requiredProperties: ["status", "body"] },
      extraction: {},
    };

    const terminals = findTerminals(func, [pattern]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminal.statusCode).toBeNull();
    expect(terminals[0].terminal.body).toBeNull();
  });
});
