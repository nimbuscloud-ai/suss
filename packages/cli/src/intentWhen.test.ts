import { describe, expect, it } from "vitest";

import { draftedWhen } from "./intentWhen.js";

import type { Predicate, Transition, ValueRef } from "@suss/behavioral-ir";

const id: ValueRef = { type: "input", inputRef: "request.params.id", path: [] };
const role: ValueRef = {
  type: "input",
  inputRef: "user",
  path: ["role"],
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

function said(conditions: Predicate[], isDefault = false): string {
  return draftedWhen(branch(conditions, isDefault), false);
}

describe("the fall-through branch", () => {
  it("is one word, rather than a negated copy of the guard above", () => {
    const negated: Predicate = {
      type: "negation",
      operand: {
        type: "comparison",
        left: { type: "unresolved", sourceText: "typeof invoiceId" },
        op: "neq",
        right: { type: "literal", value: "string" },
      },
    };

    expect(said([negated], true)).toBe("otherwise");
  });

  it("is what a branch guards nothing gets, when it comes first", () => {
    expect(draftedWhen(branch([], true), true)).toBe(
      "every call reaches this outcome",
    );
  });
});

describe("a guard as a sentence", () => {
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

  it("reads a typeof check as the type it wanted", () => {
    expect(
      said([
        {
          type: "comparison",
          left: { type: "unresolved", sourceText: "typeof invoiceId" },
          op: "neq",
          right: { type: "literal", value: "string" },
        },
      ]),
    ).toBe("invoiceId is not a string");
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
    const compound: Predicate = {
      type: "compound",
      op: "or",
      operands: [
        { type: "truthinessCheck", subject: id, negated: false },
        { type: "truthinessCheck", subject: role, negated: true },
      ],
    };

    expect(said([compound])).toBe(
      "request.params.id is set or user.role is missing",
    );
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
      said([
        {
          type: "negation",
          operand: {
            type: "opaque",
            sourceText: "a && b(c)",
            reason: "unsupportedSyntax",
          },
        },
      ]),
    ).toBe("not (a && b(c))");
  });

  it("joins several guards on one branch with and", () => {
    expect(
      said([
        { type: "truthinessCheck", subject: id, negated: false },
        { type: "truthinessCheck", subject: role, negated: true },
      ]),
    ).toBe("request.params.id is set and user.role is missing");
  });
});
