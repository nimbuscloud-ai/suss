import { describe, expect, it } from "vitest";

import { predicatesMatch, subjectsMatch } from "./match.js";

import type { Predicate, ValueRef } from "@suss/behavioral-ir";

describe("subjectsMatch", () => {
  it("matches identical input refs", () => {
    const a: ValueRef = {
      type: "input",
      inputRef: "args",
      path: ["params", "id"],
    };
    const b: ValueRef = {
      type: "input",
      inputRef: "args",
      path: ["params", "id"],
    };
    expect(subjectsMatch(a, b)).toBe("match");
  });

  it("rejects inputs with different paths", () => {
    const a: ValueRef = {
      type: "input",
      inputRef: "args",
      path: ["params", "id"],
    };
    const b: ValueRef = {
      type: "input",
      inputRef: "args",
      path: ["params", "slug"],
    };
    expect(subjectsMatch(a, b)).toBe("nomatch");
  });

  it("rejects different origin types outright", () => {
    const a: ValueRef = { type: "input", inputRef: "args", path: [] };
    const b: ValueRef = {
      type: "dependency",
      name: "db.find",
      accessChain: [],
    };
    expect(subjectsMatch(a, b)).toBe("nomatch");
  });

  it("matches identical literals", () => {
    expect(
      subjectsMatch(
        { type: "literal", value: 404 },
        { type: "literal", value: 404 },
      ),
    ).toBe("match");
  });

  it("matches nested derived refs structurally", () => {
    const a: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "db.findById", accessChain: [] },
      derivation: { type: "propertyAccess", property: "deletedAt" },
    };
    const b: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "db.findById", accessChain: [] },
      derivation: { type: "propertyAccess", property: "deletedAt" },
    };
    expect(subjectsMatch(a, b)).toBe("match");
  });

  it("returns unknown when either side is unresolved", () => {
    const a: ValueRef = { type: "unresolved", sourceText: "mystery" };
    const b: ValueRef = { type: "literal", value: 200 };
    expect(subjectsMatch(a, b)).toBe("unknown");
    expect(subjectsMatch(b, a)).toBe("unknown");
  });

  it("returns unknown when unresolved is nested inside a derived chain", () => {
    const a: ValueRef = {
      type: "derived",
      from: { type: "unresolved", sourceText: "?" },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const b: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "db.find", accessChain: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    expect(subjectsMatch(a, b)).toBe("unknown");
  });
});

describe("predicatesMatch", () => {
  it("matches identical comparisons", () => {
    const subject: ValueRef = {
      type: "derived",
      from: { type: "input", inputRef: "res", path: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const a: Predicate = {
      type: "comparison",
      left: subject,
      op: "eq",
      right: { type: "literal", value: 404 },
    };
    const b: Predicate = {
      type: "comparison",
      left: subject,
      op: "eq",
      right: { type: "literal", value: 404 },
    };
    expect(predicatesMatch(a, b)).toBe("match");
  });

  it("rejects different predicate kinds", () => {
    const subject: ValueRef = { type: "input", inputRef: "x", path: [] };
    const a: Predicate = { type: "nullCheck", subject, negated: false };
    const b: Predicate = { type: "truthinessCheck", subject, negated: false };
    expect(predicatesMatch(a, b)).toBe("nomatch");
  });

  it("returns unknown when either predicate is opaque", () => {
    const a: Predicate = {
      type: "opaque",
      sourceText: "isEligible(user)",
      reason: "externalFunction",
    };
    const b: Predicate = {
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    };
    expect(predicatesMatch(a, b)).toBe("unknown");
    expect(predicatesMatch(b, a)).toBe("unknown");
  });

  it("returns unknown when a compound contains an opaque operand", () => {
    const nonOpaque: Predicate = {
      type: "nullCheck",
      subject: { type: "input", inputRef: "x", path: [] },
      negated: false,
    };
    const opaque: Predicate = {
      type: "opaque",
      sourceText: "weird(x)",
      reason: "complexExpression",
    };
    const compound: Predicate = {
      type: "compound",
      op: "and",
      operands: [nonOpaque, opaque],
    };
    expect(predicatesMatch(compound, compound)).toBe("unknown");
  });

  it("returns unknown when any nested subject is unresolved", () => {
    const a: Predicate = {
      type: "comparison",
      left: { type: "unresolved", sourceText: "?" },
      op: "eq",
      right: { type: "literal", value: 1 },
    };
    const b: Predicate = {
      type: "comparison",
      left: { type: "literal", value: 1 },
      op: "eq",
      right: { type: "literal", value: 1 },
    };
    expect(predicatesMatch(a, b)).toBe("unknown");
  });

  it("matches equivalent compound predicates of resolved children", () => {
    const p: Predicate = {
      type: "compound",
      op: "and",
      operands: [
        {
          type: "nullCheck",
          subject: { type: "input", inputRef: "x", path: [] },
          negated: true,
        },
        {
          type: "comparison",
          left: { type: "input", inputRef: "y", path: [] },
          op: "gt",
          right: { type: "literal", value: 0 },
        },
      ],
    };
    expect(predicatesMatch(p, p)).toBe("match");
  });

  it("matches equivalent negations", () => {
    const inner: Predicate = {
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "user", path: [] },
      negated: false,
    };
    const a: Predicate = { type: "negation", operand: inner };
    const b: Predicate = { type: "negation", operand: inner };
    expect(predicatesMatch(a, b)).toBe("match");
  });

  it("matches equivalent calls", () => {
    const a: Predicate = {
      type: "call",
      callee: "isAdmin",
      args: [{ type: "input", inputRef: "user", path: [] }],
    };
    const b: Predicate = {
      type: "call",
      callee: "isAdmin",
      args: [{ type: "input", inputRef: "user", path: [] }],
    };
    expect(predicatesMatch(a, b)).toBe("match");
  });

  it("rejects calls with different callees", () => {
    const a: Predicate = { type: "call", callee: "isAdmin", args: [] };
    const b: Predicate = { type: "call", callee: "isOwner", args: [] };
    expect(predicatesMatch(a, b)).toBe("nomatch");
  });
});
