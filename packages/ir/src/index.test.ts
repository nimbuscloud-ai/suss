import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  BOUNDARY_ROLE,
  type CodeUnitKind,
  diffSummaries,
  type Finding,
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  type Output,
  type Predicate,
  packageExportBinding,
  parseSummaries,
  parseSummary,
  restBinding,
  runtimeConfigBinding,
  safeParseSummaries,
  safeParseSummary,
  type Transition,
} from "./index.js";

function makeSummary(transitions: Transition[]): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/test.ts",
      range: { start: 1, end: 10 },
      exportName: "test",
    },
    identity: { name: "test", exportPath: ["test"], boundaryBinding: null },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function makeTransition(id: string, output: Output): Transition {
  return {
    id,
    conditions: [],
    output,
    effects: [],
    location: { start: 1, end: 5 },
    isDefault: false,
  };
}

describe("diffSummaries", () => {
  it("returns empty arrays for identical summaries", () => {
    const t = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const summary = makeSummary([t]);
    const diff = diffSummaries(summary, summary);
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects an added transition", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t2 = makeTransition("t2", {
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1]);
    const after = makeSummary([t1, t2]);
    const diff = diffSummaries(before, after);
    expect(diff.addedTransitions).toHaveLength(1);
    expect(diff.addedTransitions[0].id).toBe("t2");
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a removed transition", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t2 = makeTransition("t2", {
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1, t2]);
    const after = makeSummary([t1]);
    const diff = diffSummaries(before, after);
    expect(diff.removedTransitions).toHaveLength(1);
    expect(diff.removedTransitions[0].id).toBe("t2");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a changed transition (same id, different output)", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t1changed = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 201 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1]);
    const after = makeSummary([t1changed]);
    const diff = diffSummaries(before, after);
    expect(diff.changedTransitions).toHaveLength(1);
    expect(diff.changedTransitions[0].before.id).toBe("t1");
    expect(diff.changedTransitions[0].after.id).toBe("t1");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
  });

  it("Predicate discriminated union narrows correctly", () => {
    const pred: Predicate = {
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "x" },
      negated: false,
    };
    if (pred.type === "nullCheck") {
      expect(pred.negated).toBe(false);
    } else {
      throw new Error("unexpected predicate type");
    }
  });

  it("Output discriminated union narrows correctly", () => {
    const output: Output = {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    };
    if (output.type === "response") {
      expect(output.statusCode).toBeDefined();
      expect(output.headers).toBeDefined();
    } else {
      throw new Error("unexpected output type");
    }
  });

  it("Output.response statusCode can be a dynamic ValueRef", () => {
    const output: Output = {
      type: "response",
      statusCode: { type: "unresolved", sourceText: "statusVar" },
      body: null,
      headers: {},
    };
    expect(output.type).toBe("response");
    if (output.type === "response") {
      expect(output.statusCode?.type).toBe("unresolved");
    }
  });

  it("Finding discriminated union narrows on kind and severity", () => {
    const finding: Finding = {
      kind: "unhandledProviderCase",
      boundary: {
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "ts-rest",
      },
      provider: {
        summary: "src/handlers/users.ts::getUser",
        transitionId: "t-200",
        location: {
          file: "src/handlers/users.ts",
          range: { start: 1, end: 20 },
          exportName: "getUser",
        },
      },
      consumer: {
        summary: "src/ui/user-page.ts::UserPage",
        location: {
          file: "src/ui/user-page.ts",
          range: { start: 10, end: 40 },
          exportName: "UserPage",
        },
      },
      description: "Provider returns 200 but no consumer branch reads it",
      severity: "error",
    };
    expect(finding.kind).toBe("unhandledProviderCase");
    expect(finding.consumer.transitionId).toBeUndefined();
    expect(finding.provider.transitionId).toBe("t-200");
  });
});

// ---------------------------------------------------------------------------
// Schema validation (zod-based)
// ---------------------------------------------------------------------------

describe("BehavioralSummaryArraySchema", () => {
  it("validates a minimal summary array", () => {
    const summaries: BehavioralSummary[] = [
      makeSummary([
        makeTransition("t1", {
          type: "response",
          statusCode: { type: "literal", value: 200 },
          body: null,
          headers: {},
        }),
      ]),
    ];
    const result = safeParseSummaries(summaries);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("validates a summary with all predicate types", () => {
    const t: Transition = {
      id: "complex",
      conditions: [
        {
          type: "nullCheck",
          subject: { type: "input", inputRef: "user", path: [] },
          negated: false,
        },
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "dependency", name: "db.find", accessChain: [] },
            derivation: { type: "propertyAccess", property: "deletedAt" },
          },
          negated: true,
        },
        {
          type: "comparison",
          left: { type: "input", inputRef: "status", path: [] },
          op: "eq",
          right: { type: "literal", value: 200 },
        },
        {
          type: "typeCheck",
          subject: { type: "unresolved", sourceText: "err" },
          expectedType: "HttpError",
        },
        {
          type: "propertyExists",
          subject: { type: "input", inputRef: "body", path: [] },
          property: "email",
          negated: false,
        },
        {
          type: "compound",
          op: "or",
          operands: [
            {
              type: "comparison",
              left: { type: "input", inputRef: "x", path: [] },
              op: "eq",
              right: { type: "literal", value: 1 },
            },
            {
              type: "comparison",
              left: { type: "input", inputRef: "x", path: [] },
              op: "eq",
              right: { type: "literal", value: 2 },
            },
          ],
        },
        {
          type: "negation",
          operand: {
            type: "call",
            callee: "isValid",
            args: [{ type: "input", inputRef: "data", path: [] }],
          },
        },
        {
          type: "opaque",
          sourceText: "complexExpr()",
          reason: "complexExpression",
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "not found" },
            code: { type: "integer" },
          },
        },
        headers: {},
      },
      effects: [
        { type: "mutation", target: "users", operation: "delete" },
        { type: "invocation", callee: "logger.warn", args: [], async: false },
      ],
      location: { start: 10, end: 30 },
      isDefault: false,
    };

    const summaries: BehavioralSummary[] = [makeSummary([t])];
    const result = safeParseSummaries(summaries);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("validates a summary with metadata and expectedInput", () => {
    const t: Transition = {
      id: "client-branch",
      conditions: [],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: true,
      expectedInput: {
        type: "record",
        properties: { name: { type: "unknown" } },
      },
    };

    const summaries: BehavioralSummary[] = [
      {
        kind: "client",
        location: {
          file: "consumer.ts",
          range: { start: 1, end: 10 },
          exportName: "loadUser",
        },
        identity: {
          name: "loadUser",
          exportPath: ["loadUser"],
          boundaryBinding: {
            transport: "http",
            semantics: { name: "rest", method: "GET", path: "/users/:id" },
            recognition: "fetch",
          },
        },
        inputs: [],
        transitions: [t],
        gaps: [],
        confidence: { source: "inferred_static", level: "high" },
        metadata: {
          http: {
            declaredContract: {
              framework: "ts-rest",
              responses: [{ statusCode: 200 }, { statusCode: 404 }],
            },
          },
        },
      },
    ];

    const result = safeParseSummaries(summaries);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("validates a transition with per-transition metadata", () => {
    const t: Transition = {
      id: "platform-401",
      conditions: [
        {
          type: "opaque",
          sourceText: "platform:apiGateway:authorization.denied",
          reason: "externalFunction",
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 401 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      confidence: { source: "derived", level: "high" },
      metadata: {
        source: "aws::apigateway::method.authorization",
        configRef: "template.yaml#/Resources/Auth",
        causes: ["iam-authorizer", "api-key"],
      },
    };

    const summaries: BehavioralSummary[] = [makeSummary([t])];
    const result = safeParseSummaries(summaries);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it("rejects invalid data", () => {
    expect(safeParseSummaries([{ kind: "invalid" }]).success).toBe(false);
    expect(safeParseSummaries("not an array").success).toBe(false);
    expect(safeParseSummaries([{ kind: "handler" }]).success).toBe(false);
  });

  it("parseSummary throws on invalid; safeParseSummary surfaces issues", () => {
    expect(() => parseSummary({ kind: "bogus" })).toThrow();
    const result = safeParseSummary({ kind: "bogus" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("parseSummaries returns the typed array on success", () => {
    const minimal = makeSummary([
      makeTransition("t1", {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      }),
    ]);
    const parsed = parseSummaries([minimal]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("handler");
  });
});

describe("binding constructors", () => {
  it("restBinding uppercases method and omits declaredResponses when absent", () => {
    const b = restBinding({
      transport: "http",
      method: "get",
      path: "/x",
      recognition: "axios",
    });
    expect(b).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/x" },
      recognition: "axios",
    });
  });

  it("restBinding preserves declaredResponses when given", () => {
    const b = restBinding({
      transport: "http",
      method: "GET",
      path: "/x",
      recognition: "openapi",
      declaredResponses: [200, 404],
    });
    if (b.semantics.name !== "rest") {
      throw new Error("expected rest semantics");
    }
    expect(b.semantics.declaredResponses).toEqual([200, 404]);
  });

  it("functionCallBinding emits function-call semantics with optional fields", () => {
    const base = functionCallBinding({
      transport: "in-process",
      recognition: "react",
    });
    expect(base.semantics).toEqual({ name: "function-call" });

    const withModule = functionCallBinding({
      transport: "in-process",
      recognition: "react",
      module: "./Button",
      exportName: "Button",
    });
    expect(withModule.semantics).toEqual({
      name: "function-call",
      module: "./Button",
      exportName: "Button",
    });

    const withPackage = functionCallBinding({
      transport: "in-process",
      recognition: "package-exports:@suss/behavioral-ir",
      package: "@suss/behavioral-ir",
      exportPath: ["parseSummary"],
    });
    expect(withPackage.semantics).toEqual({
      name: "function-call",
      package: "@suss/behavioral-ir",
      exportPath: ["parseSummary"],
    });
  });

  it("packageExportBinding wraps function-call with package identity", () => {
    const b = packageExportBinding({
      recognition: "package-exports:@suss/behavioral-ir",
      packageName: "@suss/behavioral-ir",
      exportPath: ["schemas", "BehavioralSummarySchema"],
    });
    expect(b).toEqual({
      transport: "in-process",
      semantics: {
        name: "function-call",
        package: "@suss/behavioral-ir",
        exportPath: ["schemas", "BehavioralSummarySchema"],
      },
      recognition: "package-exports:@suss/behavioral-ir",
    });
  });

  it("graphqlResolverBinding emits typeName + fieldName", () => {
    const b = graphqlResolverBinding({
      transport: "http",
      recognition: "apollo",
      typeName: "Query",
      fieldName: "users",
    });
    expect(b).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-resolver",
        typeName: "Query",
        fieldName: "users",
      },
      recognition: "apollo",
    });
  });

  it("graphqlOperationBinding records operation type; operationName optional", () => {
    const anon = graphqlOperationBinding({
      transport: "http",
      recognition: "apollo-client",
      operationType: "mutation",
    });
    expect(anon.semantics).toEqual({
      name: "graphql-operation",
      operationType: "mutation",
    });

    const named = graphqlOperationBinding({
      transport: "http",
      recognition: "apollo-client",
      operationType: "query",
      operationName: "GetUser",
    });
    expect(named.semantics).toEqual({
      name: "graphql-operation",
      operationType: "query",
      operationName: "GetUser",
    });
  });

  it("runtimeConfigBinding records deploymentTarget + instanceName under transport=os", () => {
    const b = runtimeConfigBinding({
      recognition: "cloudformation",
      deploymentTarget: "lambda",
      instanceName: "MyFunction",
    });
    expect(b).toEqual({
      transport: "os",
      semantics: {
        name: "runtime-config",
        deploymentTarget: "lambda",
        instanceName: "MyFunction",
      },
      recognition: "cloudformation",
    });
  });
});

describe("BOUNDARY_ROLE", () => {
  it("classifies every CodeUnitKind", () => {
    const allKinds: CodeUnitKind[] = [
      "handler",
      "loader",
      "action",
      "component",
      "hook",
      "middleware",
      "resolver",
      "consumer",
      "client",
      "worker",
      "library",
      "caller",
    ];
    for (const kind of allKinds) {
      expect(BOUNDARY_ROLE[kind]).toMatch(/^(provider|consumer)$/);
    }
  });

  it("classifies non-HTTP provider kinds (worker, component, hook, library) as providers", () => {
    expect(BOUNDARY_ROLE.worker).toBe("provider");
    expect(BOUNDARY_ROLE.component).toBe("provider");
    expect(BOUNDARY_ROLE.hook).toBe("provider");
    expect(BOUNDARY_ROLE.library).toBe("provider");
  });

  it("classifies client, consumer, and caller as consumers", () => {
    expect(BOUNDARY_ROLE.client).toBe("consumer");
    expect(BOUNDARY_ROLE.consumer).toBe("consumer");
    expect(BOUNDARY_ROLE.caller).toBe("consumer");
  });
});
