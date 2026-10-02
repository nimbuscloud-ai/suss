import { describe, expect, it } from "vitest";

import {
  predicateRefs,
  refEndsInMember,
  statusMembersOf,
  testsStatus,
} from "./statusTests.js";

import type { Predicate, ValueRef } from "./index.js";

const fetchStatus: ValueRef = {
  type: "derived",
  from: { type: "dependency", name: "fetch", accessChain: [] },
  derivation: { type: "propertyAccess", property: "status" },
};

const pythonStatus: ValueRef = {
  type: "dependency",
  name: "resp",
  accessChain: ["status_code"],
};

const literal = (value: number): ValueRef => ({ type: "literal", value });

describe("testsStatus", () => {
  it("reads a comparison on a status member through a negation", () => {
    const test: Predicate = {
      type: "negation",
      operand: {
        type: "comparison",
        left: fetchStatus,
        op: "eq",
        right: literal(200),
      },
    };

    expect(testsStatus(test, statusMembersOf({}))).toBe(true);
  });

  it("reads the members a pack lists in place of the defaults", () => {
    const test: Predicate = {
      type: "comparison",
      left: pythonStatus,
      op: "eq",
      right: literal(404),
    };

    expect(testsStatus(test, statusMembersOf({}))).toBe(false);
    expect(
      testsStatus(test, statusMembersOf({ statusAccessors: ["status_code"] })),
    ).toBe(true);
  });

  it("leaves out a test on anything else", () => {
    const test: Predicate = {
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "user", path: ["active"] },
      negated: false,
    };

    expect(testsStatus(test, statusMembersOf({}))).toBe(false);
  });
});

describe("refEndsInMember", () => {
  it("counts a destructured field as a read of that field", () => {
    const status: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "call", accessChain: [] },
      derivation: { type: "destructured", field: "status" },
    };

    expect(refEndsInMember(status, new Set(["status"]))).toBe(true);
  });
});

describe("predicateRefs", () => {
  it("collects the values under a compound and a call", () => {
    const test: Predicate = {
      type: "compound",
      op: "and",
      operands: [
        { type: "call", callee: "check", args: [pythonStatus] },
        { type: "opaque", sourceText: "x", reason: "complexExpression" },
      ],
    };

    expect(predicateRefs(test)).toEqual([pythonStatus]);
  });
});
