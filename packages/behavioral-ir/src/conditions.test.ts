import { describe, expect, it } from "vitest";

import {
  boundaryCalls,
  boundaryGuardsOf,
  guardSubject,
  polarityOf,
} from "./conditions.js";
import { storageBinding } from "./index.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  ValueRef,
} from "./index.js";

const invoices = storageBinding({
  recognition: "@suss/framework-aws-dynamodb",
  storageSystem: "aws.dynamodb",
  scope: "default",
  container: "Invoices",
});

/** The result of the call that reached the table, read down to `.Item`. */
const theRow: ValueRef = {
  type: "derived",
  from: { type: "dependency", name: "dynamo.send", accessChain: [] },
  derivation: { type: "propertyAccess", property: "Item" },
};

function branch(conditions: Transition["conditions"]): Transition {
  return {
    id: "t",
    conditions,
    output: { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 2 },
    isDefault: false,
  };
}

/** The read runs before the branch, so only the path past it records it. */
function unit(branches: Transition[]): BehavioralSummary {
  const reader = branch([]);
  reader.effects = [
    {
      type: "interaction",
      binding: invoices,
      callee: "dynamo.send",
      interaction: { class: "storage-access", kind: "read", fields: ["id"] },
    },
  ];
  return {
    kind: "handler",
    location: {
      file: "src/lookup.ts",
      range: { start: 1, end: 9 },
      exportName: null,
    },
    identity: { name: "getInvoice", exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [...branches, reader],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("boundaryCalls", () => {
  it("says which boundary each call the unit makes reached", () => {
    const calls = boundaryCalls(unit([]));

    expect(calls.get("dynamo.send")).toEqual({
      does: "reads",
      binding: invoices,
    });
  });
});

describe("boundaryGuardsOf", () => {
  it("joins a guard on a call's result to the boundary that call reached", () => {
    const one = branch([
      { type: "truthinessCheck", subject: theRow, negated: true },
    ]);

    const guards = boundaryGuardsOf(one, boundaryCalls(unit([one])));

    expect(guards).toHaveLength(1);
    expect(guards[0].does).toBe("reads");
    expect(guards[0].binding).toEqual(invoices);
    expect(guards[0].path).toEqual(["Item"]);
    expect(guards[0].polarity).toBe("nothing");
  });

  it("flips the polarity through a negation and keeps the whole condition", () => {
    const inner: Predicate = {
      type: "truthinessCheck",
      subject: theRow,
      negated: true,
    };
    const one = branch([{ type: "negation", operand: inner }]);

    const guards = boundaryGuardsOf(one, boundaryCalls(unit([one])));

    expect(guards[0].polarity).toBe("something");
    expect(guards[0].condition.type).toBe("negation");
    expect(guards[0].predicate).toEqual(inner);
  });

  it("leaves out a guard on a call that crosses no boundary", () => {
    const other: ValueRef = {
      type: "dependency",
      name: "cache.get",
      accessChain: [],
    };
    const one = branch([
      { type: "truthinessCheck", subject: other, negated: false },
    ]);

    expect(boundaryGuardsOf(one, boundaryCalls(unit([one])))).toEqual([]);
  });

  it("leaves out an effect that is not an interaction, and one with no callee", () => {
    const one = branch([
      { type: "truthinessCheck", subject: theRow, negated: true },
    ]);
    const bare = unit([one]);
    bare.transitions[1].effects = [
      { type: "invocation", callee: "dynamo.send", args: [], async: true },
      {
        type: "interaction",
        binding: invoices,
        interaction: { class: "storage-access", kind: "read", fields: [] },
      },
    ];

    expect(boundaryGuardsOf(one, boundaryCalls(bare))).toEqual([]);
  });

  it("reads a guard through a destructured field and an index the same", () => {
    const destructured: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "dynamo.send", accessChain: [] },
      derivation: { type: "destructured", field: "Item" },
    };
    const indexed: ValueRef = {
      type: "derived",
      from: destructured,
      derivation: { type: "indexAccess", index: 0 },
    };
    const one = branch([
      { type: "truthinessCheck", subject: indexed, negated: false },
    ]);

    const guards = boundaryGuardsOf(one, boundaryCalls(unit([one])));

    expect(guards[0].path).toEqual(["Item"]);
  });

  it("leaves out a guard on what the caller sent", () => {
    const one = branch([
      {
        type: "truthinessCheck",
        subject: { type: "input", inputRef: "request.params.id", path: [] },
        negated: true,
      },
    ]);

    expect(boundaryGuardsOf(one, boundaryCalls(unit([one])))).toEqual([]);
  });
});

describe("polarityOf", () => {
  const subject: ValueRef = { type: "input", inputRef: "x", path: [] };

  it("reads a truthiness check the way it is written", () => {
    expect(
      polarityOf({ type: "truthinessCheck", subject, negated: true }),
    ).toBe("nothing");
    expect(
      polarityOf({ type: "truthinessCheck", subject, negated: false }),
    ).toBe("something");
  });

  it("reads `x == null` as nothing being there", () => {
    expect(polarityOf({ type: "nullCheck", subject, negated: false })).toBe(
      "nothing",
    );
    expect(polarityOf({ type: "nullCheck", subject, negated: true })).toBe(
      "something",
    );
  });

  it("has no answer for a guard that asks something else", () => {
    expect(
      polarityOf({ type: "typeCheck", subject, expectedType: "string" }),
    ).toBeNull();
    expect(
      polarityOf({
        type: "negation",
        operand: { type: "typeCheck", subject, expectedType: "string" },
      }),
    ).toBeNull();
  });
});

describe("guardSubject", () => {
  it("walks a chain of property reads back to what it started from", () => {
    expect(
      guardSubject({ type: "truthinessCheck", subject: theRow, negated: true }),
    ).toEqual({ dependency: "dynamo.send", input: null, path: ["Item"] });
  });

  it("says which input, path included, when the caller sent it", () => {
    expect(
      guardSubject({
        type: "comparison",
        left: { type: "input", inputRef: "user", path: ["role"] },
        op: "eq",
        right: { type: "literal", value: "admin" },
      }),
    ).toEqual({ dependency: null, input: "user.role", path: [] });
  });

  it("has no answer for a guard about several values at once", () => {
    expect(
      guardSubject({ type: "compound", op: "and", operands: [] }),
    ).toBeNull();
  });

  it("reads through a negation to what is underneath", () => {
    expect(
      guardSubject({
        type: "negation",
        operand: {
          type: "truthinessCheck",
          subject: theRow,
          negated: false,
        },
      }),
    ).toEqual({ dependency: "dynamo.send", input: null, path: ["Item"] });
  });

  it("has no answer for a value the source never settled", () => {
    expect(
      guardSubject({
        type: "truthinessCheck",
        subject: { type: "unresolved", sourceText: "a && b" },
        negated: false,
      }),
    ).toBeNull();
  });
});
