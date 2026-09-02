import { describe, expect, it } from "vitest";

import { NOTHING_DEPLOYED, storageBinding } from "@suss/behavioral-ir";

import { draftedWhen, saidPlainly } from "./intentWhen.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

const id: ValueRef = { type: "input", inputRef: "request.params.id", path: [] };
const role: ValueRef = { type: "input", inputRef: "user", path: ["role"] };

/** The result of the call that reached the table, read down to `.Item`. */
const theRow: ValueRef = {
  type: "derived",
  from: { type: "dependency", name: "dynamo.send", accessChain: [] },
  derivation: { type: "propertyAccess", property: "Item" },
};

const settledAt: ValueRef = {
  type: "derived",
  from: theRow,
  derivation: { type: "propertyAccess", property: "settledAt" },
};

function branch(conditions: Predicate[], isDefault = false): Transition {
  return {
    id: "t",
    conditions,
    output: { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 2 },
    isDefault,
  };
}

/** A unit whose `dynamo.send` is recorded as a read of the Invoices table. */
function unitReadingInvoices(branches: Transition[]): BehavioralSummary {
  const reader = branch([]);
  reader.effects = [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: "@suss/framework-aws-dynamodb",
        storageSystem: "aws.dynamodb",
        scope: "default",
        container: "Invoices",
      }),
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

function drafted(conditions: Predicate[], isDefault = false) {
  const one = branch(conditions, isDefault);
  return draftedWhen(one, unitReadingInvoices([one]), false, NOTHING_DEPLOYED);
}

function said(conditions: Predicate[]): string {
  return saidPlainly(conditions[0], false, []);
}

describe("a clause that says which boundary the branch read", () => {
  it("says the store and that the read came back with nothing", () => {
    expect(
      drafted([{ type: "truthinessCheck", subject: theRow, negated: true }]),
    ).toEqual([{ reads: "aws.dynamodb:Invoices", finds: "nothing" }]);
  });

  it("flips through a negation rather than writing one out", () => {
    expect(
      drafted([
        {
          type: "negation",
          operand: { type: "truthinessCheck", subject: theRow, negated: true },
        },
      ]),
    ).toEqual([{ reads: "aws.dynamodb:Invoices", finds: "something" }]);
  });

  it("narrows one clause with what a deeper read of the same result said", () => {
    expect(
      drafted([
        {
          type: "negation",
          operand: { type: "truthinessCheck", subject: theRow, negated: true },
        },
        { type: "truthinessCheck", subject: settledAt, negated: false },
      ]),
    ).toEqual([
      {
        reads: "aws.dynamodb:Invoices",
        finds: "something",
        where: "settledAt is set",
      },
    ]);
  });

  it("says a null check on the result the same way", () => {
    expect(
      drafted([{ type: "nullCheck", subject: theRow, negated: false }]),
    ).toEqual([{ reads: "aws.dynamodb:Invoices", finds: "nothing" }]);
  });

  it("keeps the boundary and puts a comparison under where", () => {
    expect(
      drafted([
        {
          type: "comparison",
          left: settledAt,
          op: "eq",
          right: { type: "literal", value: "yesterday" },
        },
      ]),
    ).toEqual([
      {
        reads: "aws.dynamodb:Invoices",
        where: 'Item.settledAt is "yesterday"',
      },
    ]);
  });

  it("keeps the whole read back when no clause beside it said finds", () => {
    expect(
      drafted([
        {
          type: "comparison",
          left: settledAt,
          op: "eq",
          right: { type: "literal", value: "yesterday" },
        },
        { type: "truthinessCheck", subject: theRow, negated: false },
      ]),
    ).toEqual([
      {
        reads: "aws.dynamodb:Invoices",
        finds: "something",
        where: 'settledAt is "yesterday"',
      },
    ]);
  });
});

describe("a clause about what the caller sent", () => {
  it("says which input and what state it was in", () => {
    expect(
      drafted([{ type: "truthinessCheck", subject: id, negated: true }]),
    ).toEqual([{ input: "request.params.id", is: "missing" }]);
    expect(
      drafted([{ type: "truthinessCheck", subject: role, negated: false }]),
    ).toEqual([{ input: "user.role", is: "set" }]);
  });

  it("puts anything that is not a presence check under where", () => {
    expect(
      drafted([
        {
          type: "comparison",
          left: role,
          op: "eq",
          right: { type: "literal", value: "admin" },
        },
      ]),
    ).toEqual([{ input: "user.role", where: 'user.role is "admin"' }]);
  });
});

describe("the fall-through branch", () => {
  it("states its own condition, since it has one", () => {
    expect(
      drafted(
        [
          {
            type: "negation",
            operand: {
              type: "truthinessCheck",
              subject: theRow,
              negated: true,
            },
          },
          {
            type: "negation",
            operand: {
              type: "truthinessCheck",
              subject: settledAt,
              negated: false,
            },
          },
        ],
        true,
      ),
    ).toEqual([
      {
        reads: "aws.dynamodb:Invoices",
        finds: "something",
        where: "settledAt is missing",
      },
    ]);
  });

  it("says the guard positively, whatever the branch above claimed", () => {
    const negated: Predicate = {
      type: "negation",
      operand: {
        type: "comparison",
        left: { type: "unresolved", sourceText: "typeof invoiceId" },
        op: "neq",
        right: { type: "literal", value: "string" },
      },
    };

    expect(drafted([negated], true)).toBe("invoiceId is a string");
  });

  it("falls back to one word only when the summary never recorded a guard", () => {
    const one = branch([], true);

    expect(
      draftedWhen(one, unitReadingInvoices([one]), false, NOTHING_DEPLOYED),
    ).toBe("otherwise");
    expect(
      draftedWhen(one, unitReadingInvoices([one]), true, NOTHING_DEPLOYED),
    ).toBe("every call reaches this outcome");
  });
});

describe("a guard no boundary and no input explains", () => {
  it("stays one sentence on the line", () => {
    expect(
      drafted([
        {
          type: "comparison",
          left: { type: "unresolved", sourceText: "typeof invoiceId" },
          op: "neq",
          right: { type: "literal", value: "string" },
        },
      ]),
    ).toBe("invoiceId is not a string");
  });

  it("says whether a value is there", () => {
    expect(
      said([{ type: "truthinessCheck", subject: id, negated: true }]),
    ).toBe("request.params.id is missing");
    expect(
      said([{ type: "truthinessCheck", subject: id, negated: false }]),
    ).toBe("request.params.id is set");
  });

  it("says what a value is compared against", () => {
    expect(
      said([
        {
          type: "comparison",
          left: role,
          op: "eq",
          right: { type: "literal", value: "admin" },
        },
      ]),
    ).toBe('user.role is "admin"');
  });

  it("leaves a comparison alone when it is not a typeof check", () => {
    expect(
      said([
        {
          type: "comparison",
          left: { type: "unresolved", sourceText: "items.length" },
          op: "gt",
          right: { type: "literal", value: 0 },
        },
      ]),
    ).toBe("items.length is more than 0");
    expect(
      said([
        {
          type: "comparison",
          left: { type: "unresolved", sourceText: "typeof invoiceId" },
          op: "gt",
          right: { type: "literal", value: "string" },
        },
      ]),
    ).toBe('typeof invoiceId is more than "string"');
  });

  it("flips the comparison rather than writing a negation of it", () => {
    expect(
      said([
        {
          type: "negation",
          operand: {
            type: "comparison",
            left: role,
            op: "gt",
            right: { type: "literal", value: 3 },
          },
        },
      ]),
    ).toBe("user.role is at most 3");
  });

  it("says a null check, a declared type check and a property", () => {
    expect(said([{ type: "nullCheck", subject: id, negated: true }])).toBe(
      "request.params.id is not null",
    );
    expect(
      said([{ type: "typeCheck", subject: id, expectedType: "string" }]),
    ).toBe("request.params.id is a string");
    expect(
      said([
        {
          type: "propertyExists",
          subject: id,
          property: "authorization",
          negated: true,
        },
      ]),
    ).toBe('request.params.id has no "authorization"');
  });

  it("says a predicate call as the answer it wanted back", () => {
    expect(said([{ type: "call", callee: "isAdmin", args: [role] }])).toBe(
      "isAdmin(user.role) is true",
    );
  });

  it("joins the operands of a compound with its own word", () => {
    expect(
      said([
        {
          type: "compound",
          op: "or",
          operands: [
            { type: "truthinessCheck", subject: id, negated: false },
            { type: "truthinessCheck", subject: role, negated: true },
          ],
        },
      ]),
    ).toBe("request.params.id is set or user.role is missing");
  });

  it("keeps the source text of a guard nothing above reads", () => {
    expect(
      said([
        {
          type: "opaque",
          sourceText: " a && b(c) ",
          reason: "unsupportedSyntax",
        },
      ]),
    ).toBe("a && b(c)");
    expect(
      saidPlainly(
        {
          type: "opaque",
          sourceText: "a && b(c)",
          reason: "unsupportedSyntax",
        },
        true,
        [],
      ),
    ).toBe("not (a && b(c))");
  });
});
