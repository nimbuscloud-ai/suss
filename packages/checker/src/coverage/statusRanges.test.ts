import { describe, expect, it } from "vitest";

import { branchStatusRanges, fallthroughGuards } from "./statusRanges.js";

import type { Predicate, ValueRef } from "@suss/behavioral-ir";

const STATUS: StatusAccessorsArg = new Set(["status"]);
const SUCCESS: StatusAccessorsArg = new Set(["ok"]);

type StatusAccessorsArg = ReadonlySet<string>;

const statusRef: ValueRef = {
  type: "derived",
  from: { type: "dependency", name: "fetch", accessChain: [] },
  derivation: { type: "propertyAccess", property: "status" },
};

const bodyRef: ValueRef = {
  type: "derived",
  from: { type: "dependency", name: "fetch", accessChain: [] },
  derivation: { type: "propertyAccess", property: "code" },
};

const compare = (
  left: ValueRef,
  op: "gte" | "gt" | "lte" | "lt" | "eq",
  value: number,
): Predicate => ({
  type: "comparison",
  left,
  op,
  right: { type: "literal", value },
});

/** `400 <= res.status`, the same bound written the other way round. */
const compareFlipped = (
  op: "gte" | "gt" | "lte" | "lt",
  value: number,
): Predicate => ({
  type: "comparison",
  left: { type: "literal", value },
  op,
  right: statusRef,
});

const ranges = (conditions: Predicate[]) =>
  branchStatusRanges(conditions, fallthroughGuards(STATUS, SUCCESS));

/** The same conditions read as an arm the consumer wrote. */
const armRanges = (conditions: Predicate[]) =>
  branchStatusRanges(conditions, {
    accessors: STATUS,
    successAccessors: SUCCESS,
    readsEquality: true,
  });

describe("branchStatusRanges", () => {
  it("says nothing when no condition mentions a status", () => {
    expect(ranges([compare(bodyRef, "gte", 400)])).toBeNull();
    expect(ranges([])).toBeNull();
  });

  it("says nothing about a comparison against one number on the fall-through", () => {
    expect(ranges([compare(statusRef, "eq", 404)])).toBeNull();
    expect(ranges([{ type: "negation", operand: compare(statusRef, "eq", 404) }])).toBeNull();
  });

  it("reads an arm's equality as the one status it names", () => {
    expect(armRanges([compare(statusRef, "eq", 404)])).toEqual([
      { min: 404, max: 404 },
    ]);
  });

  it("reads an else arm as every status the guard left over", () => {
    expect(
      armRanges([{ type: "negation", operand: compare(statusRef, "eq", 404) }]),
    ).toEqual([
      { min: 100, max: 403 },
      { min: 405, max: 599 },
    ]);
  });

  it("reads each one-sided bound as the run it describes", () => {
    expect(ranges([compare(statusRef, "gte", 400)])).toEqual([
      { min: 400, max: 599 },
    ]);
    expect(ranges([compare(statusRef, "gt", 400)])).toEqual([
      { min: 401, max: 599 },
    ]);
    expect(ranges([compare(statusRef, "lte", 299)])).toEqual([
      { min: 100, max: 299 },
    ]);
    expect(ranges([compare(statusRef, "lt", 300)])).toEqual([
      { min: 100, max: 299 },
    ]);
  });

  it("reads a bound written with the literal first", () => {
    expect(ranges([compareFlipped("lte", 400)])).toEqual([
      { min: 400, max: 599 },
    ]);
    expect(ranges([compareFlipped("gte", 299)])).toEqual([
      { min: 100, max: 299 },
    ]);
  });

  it("says nothing when the other side is not a number", () => {
    expect(
      ranges([
        {
          type: "comparison",
          left: statusRef,
          op: "gte",
          right: { type: "literal", value: "400" },
        },
      ]),
    ).toBeNull();
  });

  it("intersects the two halves of a 2xx range into one run", () => {
    expect(
      ranges([
        {
          type: "compound",
          op: "and",
          operands: [
            compare(statusRef, "gte", 200),
            compare(statusRef, "lte", 299),
          ],
        },
      ]),
    ).toEqual([{ min: 200, max: 299 }]);
  });

  it("complements a negated range into the two runs outside it", () => {
    expect(
      ranges([
        {
          type: "negation",
          operand: {
            type: "compound",
            op: "and",
            operands: [
              compare(statusRef, "gte", 200),
              compare(statusRef, "lte", 299),
            ],
          },
        },
      ]),
    ).toEqual([
      { min: 100, max: 199 },
      { min: 300, max: 599 },
    ]);
  });

  it("unions the operands of an or", () => {
    expect(
      ranges([
        {
          type: "compound",
          op: "or",
          operands: [
            compare(statusRef, "lt", 200),
            compare(statusRef, "gte", 500),
          ],
        },
      ]),
    ).toEqual([
      { min: 100, max: 199 },
      { min: 500, max: 599 },
    ]);
  });

  it("says nothing about an or whose other operand says nothing", () => {
    expect(
      ranges([
        {
          type: "compound",
          op: "or",
          operands: [
            compare(statusRef, "gte", 500),
            compare(bodyRef, "eq", 7),
          ],
        },
      ]),
    ).toBeNull();
  });

  it("keeps the status half of an and whose other half says nothing", () => {
    expect(
      ranges([
        {
          type: "compound",
          op: "and",
          operands: [
            compare(statusRef, "gte", 500),
            {
              type: "truthinessCheck",
              subject: bodyRef,
              negated: false,
            },
          ],
        },
      ]),
    ).toEqual([{ min: 500, max: 599 }]);
  });

  it("says nothing about an and where neither half mentions a status", () => {
    expect(
      ranges([
        {
          type: "compound",
          op: "and",
          operands: [compare(bodyRef, "gte", 1), compare(bodyRef, "lte", 9)],
        },
      ]),
    ).toBeNull();
  });

  it("reads the success flag as the 2xx class, either way round", () => {
    const flag = (negated: boolean): Predicate => ({
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "dependency", name: "fetch", accessChain: [] },
        derivation: { type: "propertyAccess", property: "ok" },
      },
      negated,
    });
    expect(ranges([flag(false)])).toEqual([{ min: 200, max: 299 }]);
    expect(ranges([flag(true)])).toEqual([
      { min: 100, max: 199 },
      { min: 300, max: 599 },
    ]);
  });

  it("intersects conditions that sit on the same branch", () => {
    expect(
      ranges([compare(statusRef, "gte", 400), compare(statusRef, "lt", 500)]),
    ).toEqual([{ min: 400, max: 499 }]);
  });

  it("comes out empty when two conditions cannot both be true", () => {
    expect(
      ranges([compare(statusRef, "lt", 200), compare(statusRef, "gte", 500)]),
    ).toEqual([]);
  });

  it("clips a bound outside the status space to its edge", () => {
    expect(ranges([compare(statusRef, "gte", 0)])).toEqual([
      { min: 100, max: 599 },
    ]);
    expect(ranges([compare(statusRef, "lte", 9000)])).toEqual([
      { min: 100, max: 599 },
    ]);
  });

  it("says nothing about a predicate shape it does not read", () => {
    expect(
      ranges([{ type: "opaque", sourceText: "catch", reason: "complexExpression" }]),
    ).toBeNull();
  });
});
