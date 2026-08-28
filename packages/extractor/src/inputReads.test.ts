// A summary should say what a unit reads out of what it was given, rather
// than leaving somebody to walk the derivations and work it out themselves.

import { describe, expect, it } from "vitest";

import { inputReadsOf, mergeInputReads } from "./inputReads.js";

import type { Predicate, ValueRef } from "@suss/behavioral-ir";

const input = (name: string): ValueRef => ({
  type: "input",
  inputRef: name,
  path: [],
});

const reading = (from: ValueRef, property: string): ValueRef => ({
  type: "derived",
  from,
  derivation: { type: "propertyAccess", property },
});

const truthy = (subject: ValueRef): Predicate => ({
  type: "truthinessCheck",
  subject,
  negated: false,
});

describe("what a unit reads", () => {
  it("says the chain a condition walked", () => {
    const reads = inputReadsOf({
      conditions: [[truthy(reading(reading(input("req"), "params"), "id"))]],
      values: [],
    });

    expect(reads).toEqual([{ input: "req", path: ["params", "id"] }]);
  });

  it("says each thing once, however often it is read", () => {
    const twice = truthy(reading(input("req"), "body"));

    expect(
      inputReadsOf({ conditions: [[twice], [twice]], values: [] }),
    ).toEqual([{ input: "req", path: ["body"] }]);
  });

  it("stops at a step it has no name for", () => {
    // An index access tells us something was reached through the list, and
    // inventing a name for which element would be worse than stopping.
    const throughAnElement: ValueRef = {
      type: "derived",
      from: reading(input("req"), "items"),
      derivation: { type: "indexAccess", index: 0 },
    };

    expect(
      inputReadsOf({ conditions: [[truthy(throughAnElement)]], values: [] }),
    ).toEqual([{ input: "req", path: ["items"] }]);
  });

  it("says nothing about a value that came from somewhere else", () => {
    const fromACall: ValueRef = {
      type: "dependency",
      name: "loadUser",
      accessChain: [],
    };

    expect(
      inputReadsOf({
        conditions: [[truthy(reading(fromACall, "email"))]],
        values: [],
      }),
    ).toEqual([]);
  });

  it("reads what a destructured name stood for", () => {
    const destructured: ValueRef = {
      type: "derived",
      from: input("props"),
      derivation: { type: "destructured", field: "user" },
    };

    expect(
      inputReadsOf({
        conditions: [[truthy(reading(destructured, "id"))]],
        values: [],
      }),
    ).toEqual([{ input: "props", path: ["user", "id"] }]);
  });

  it("comes back in an order two runs agree on", () => {
    const a = truthy(reading(input("req"), "zeta"));
    const b = truthy(reading(input("req"), "alpha"));

    expect(inputReadsOf({ conditions: [[a, b]], values: [] })).toEqual(
      inputReadsOf({ conditions: [[b, a]], values: [] }),
    );
  });
});

describe("mergeInputReads", () => {
  it("keeps each read once, derived first", () => {
    const merged = mergeInputReads(
      [{ input: "props", path: ["title"] }],
      [
        { input: "props", path: ["title"] },
        { input: "props", path: ["body"] },
      ],
    );
    expect(merged).toEqual([
      { input: "props", path: ["title"] },
      { input: "props", path: ["body"] },
    ]);
  });
});
