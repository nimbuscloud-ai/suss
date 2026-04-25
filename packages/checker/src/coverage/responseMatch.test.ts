import { describe, expect, it } from "vitest";

import {
  consumerExpectedStatuses,
  extractResponseStatus,
  hasOpaqueStatus,
} from "./responseMatch.js";

import type { Predicate, Transition } from "@suss/behavioral-ir";

const DEFAULT_STATUS: ReadonlySet<string> = new Set(["status", "statusCode"]);

function txn(conditions: Predicate[]): Transition {
  return {
    id: "t",
    conditions,
    output: { type: "return", value: null },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
  };
}

describe("extractResponseStatus", () => {
  it("returns the literal status when present", () => {
    const t: Transition = {
      id: "t-200",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
    };
    expect(extractResponseStatus(t)).toBe(200);
  });

  it("returns null for non-response outputs", () => {
    const t: Transition = {
      id: "t-throw",
      conditions: [],
      output: { type: "throw", exceptionType: "Error", message: null },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
    };
    expect(extractResponseStatus(t)).toBeNull();
  });

  it("returns null when statusCode is null or unresolved", () => {
    const nullStatus: Transition = {
      id: "t-null",
      conditions: [],
      output: {
        type: "response",
        statusCode: null,
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
    };
    expect(extractResponseStatus(nullStatus)).toBeNull();

    const opaqueStatus: Transition = {
      id: "t-opaque",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "unresolved", sourceText: "code" },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
    };
    expect(extractResponseStatus(opaqueStatus)).toBeNull();
    expect(hasOpaqueStatus(opaqueStatus)).toBe(true);
    expect(hasOpaqueStatus(nullStatus)).toBe(false);
  });
});

describe("consumerExpectedStatuses", () => {
  it("finds status literals on derived subject", () => {
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "fetch", accessChain: [] },
        derivation: { type: "propertyAccess", property: "status" },
      },
      op: "eq",
      right: { type: "literal", value: 404 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([
      404,
    ]);
  });

  it("finds status literals on input path ending in status", () => {
    const pred: Predicate = {
      type: "comparison",
      left: { type: "literal", value: 500 },
      op: "eq",
      right: {
        type: "input",
        inputRef: "response",
        path: ["status"],
      },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([
      500,
    ]);
  });

  it("finds status literals on dependency accessChain ending in statusCode", () => {
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "dependency",
        name: "fetch",
        accessChain: ["statusCode"],
      },
      op: "eq",
      right: { type: "literal", value: 418 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([
      418,
    ]);
  });

  it("finds status literals on destructured derivations (`const { status }`)", () => {
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "axios.get", accessChain: [] },
        derivation: { type: "destructured", field: "status" },
      },
      op: "eq",
      right: { type: "literal", value: 404 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([
      404,
    ]);
  });

  it("finds status literals on err.response.status (try/catch shape)", () => {
    // axios throws on 4xx/5xx and stores the response on err.response.
    // The status check survives the nested derived ref because
    // refLooksLikeStatus inspects only the outermost derivation.
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: {
          type: "derived",
          from: { type: "unresolved", sourceText: "err" },
          derivation: { type: "propertyAccess", property: "response" },
        },
        derivation: { type: "propertyAccess", property: "status" },
      },
      op: "eq",
      right: { type: "literal", value: 404 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([
      404,
    ]);
  });

  it("walks into compound and negation predicates", () => {
    const pred: Predicate = {
      type: "compound",
      op: "or",
      operands: [
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "dependency", name: "fetch", accessChain: [] },
            derivation: { type: "propertyAccess", property: "status" },
          },
          op: "eq",
          right: { type: "literal", value: 500 },
        },
        {
          type: "negation",
          operand: {
            type: "comparison",
            left: {
              type: "derived",
              from: { type: "dependency", name: "fetch", accessChain: [] },
              derivation: { type: "propertyAccess", property: "status" },
            },
            op: "eq",
            right: { type: "literal", value: 503 },
          },
        },
      ],
    };
    const found = consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS).sort();
    expect(found).toEqual([500, 503]);
  });

  it("ignores non-eq comparisons", () => {
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "fetch", accessChain: [] },
        derivation: { type: "propertyAccess", property: "status" },
      },
      op: "gt",
      right: { type: "literal", value: 400 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([]);
  });

  it("ignores comparisons against non-status ValueRefs", () => {
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "fetch", accessChain: [] },
        derivation: { type: "propertyAccess", property: "userId" },
      },
      op: "eq",
      right: { type: "literal", value: 42 },
    };
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([]);
  });

  it("recognises a pack-defined status name not in the defaults", () => {
    // Hypothetical pack: response status comes through `.responseStatus`
    const pred: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "client.get", accessChain: [] },
        derivation: { type: "propertyAccess", property: "responseStatus" },
      },
      op: "eq",
      right: { type: "literal", value: 418 },
    };
    // With defaults, the property name is unknown → no match
    expect(consumerExpectedStatuses(txn([pred]), DEFAULT_STATUS)).toEqual([]);
    // With the pack's accessors, recognised
    expect(
      consumerExpectedStatuses(txn([pred]), new Set(["responseStatus"])),
    ).toEqual([418]);
  });

  it("recognises status accessors via destructured + dependency derivations", () => {
    const destructured: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "client.get", accessChain: [] },
        derivation: { type: "destructured", field: "code" },
      },
      op: "eq",
      right: { type: "literal", value: 503 },
    };
    const dependencyChain: Predicate = {
      type: "comparison",
      left: { type: "dependency", name: "res", accessChain: ["code"] },
      op: "eq",
      right: { type: "literal", value: 503 },
    };
    const accessors = new Set(["code"]);
    expect(consumerExpectedStatuses(txn([destructured]), accessors)).toEqual([
      503,
    ]);
    expect(consumerExpectedStatuses(txn([dependencyChain]), accessors)).toEqual(
      [503],
    );
  });
});
