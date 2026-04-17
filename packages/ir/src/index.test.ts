import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import schema from "../schema/behavioral-summary.schema.json";
import {
  type BehavioralSummary,
  diffSummaries,
  type Finding,
  type Output,
  type Predicate,
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
      boundary: { protocol: "http", framework: "ts-rest" },
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
// JSON Schema validation
// ---------------------------------------------------------------------------

describe("behavioral-summary.schema.json", () => {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);

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
    const valid = validate(summaries);
    if (!valid) {
      console.error(validate.errors);
    }
    expect(valid).toBe(true);
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
    const valid = validate(summaries);
    if (!valid) {
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);
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
            protocol: "http",
            method: "GET",
            path: "/users/:id",
            framework: "fetch",
          },
        },
        inputs: [],
        transitions: [t],
        gaps: [],
        confidence: { source: "inferred_static", level: "high" },
        metadata: {
          declaredContract: {
            framework: "ts-rest",
            responses: [{ statusCode: 200 }, { statusCode: 404 }],
          },
        },
      },
    ];

    const valid = validate(summaries);
    if (!valid) {
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);
  });

  it("rejects invalid data", () => {
    expect(validate([{ kind: "invalid" }])).toBe(false);
    expect(validate("not an array")).toBe(false);
    expect(validate([{ kind: "handler" }])).toBe(false);
  });
});
