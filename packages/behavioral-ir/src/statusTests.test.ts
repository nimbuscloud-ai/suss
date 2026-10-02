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
  const fetchReads = statusMembersOf({ bodyAccessors: ["json", "body"] });

  it("counts a destructured field as a read of that field", () => {
    const status: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "call", accessChain: [] },
      derivation: { type: "destructured", field: "status" },
    };

    expect(refEndsInMember(status, fetchReads)).toBe(true);
  });

  it("does not count a status field read off the parsed body", () => {
    const bodyStatus: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "response.json", accessChain: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const axiosBodyStatus: ValueRef = {
      type: "dependency",
      name: "res",
      accessChain: ["data", "status"],
    };

    expect(refEndsInMember(bodyStatus, fetchReads)).toBe(false);
    expect(
      refEndsInMember(
        axiosBodyStatus,
        statusMembersOf({ bodyAccessors: ["data"] }),
      ),
    ).toBe(false);
    expect(refEndsInMember(fetchStatus, fetchReads)).toBe(true);
  });

  it("does not count a call or an index as a member read", () => {
    const called: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "res", accessChain: [] },
      derivation: { type: "methodCall", method: "status", args: [] },
    };
    const awaited: ValueRef = {
      type: "derived",
      from: fetchStatus,
      derivation: { type: "awaited" },
    };

    expect(refEndsInMember(called, fetchReads)).toBe(false);
    expect(refEndsInMember(awaited, fetchReads)).toBe(false);
  });

  it("reads the status of one response out of a list", () => {
    const first: ValueRef = {
      type: "derived",
      from: {
        type: "derived",
        from: { type: "dependency", name: "responses", accessChain: [] },
        derivation: { type: "indexAccess", index: 0 },
      },
      derivation: { type: "propertyAccess", property: "status" },
    };

    expect(refEndsInMember(first, fetchReads)).toBe(true);
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

  it("collects the subject of a null, type and property check", () => {
    const test: Predicate = {
      type: "compound",
      op: "or",
      operands: [
        { type: "nullCheck", subject: pythonStatus, negated: false },
        { type: "typeCheck", subject: fetchStatus, expectedType: "number" },
        {
          type: "propertyExists",
          subject: pythonStatus,
          property: "code",
          negated: false,
        },
      ],
    };

    expect(predicateRefs(test)).toEqual([
      pythonStatus,
      fetchStatus,
      pythonStatus,
    ]);
  });
});
