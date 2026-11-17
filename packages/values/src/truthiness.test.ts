import { describe, expect, it } from "vitest";

import { testTruthiness } from "./testLowering.js";
import {
  everyOption,
  hasNoEntries,
  opposite,
  settledTest,
  stringIsEmpty,
} from "./truthiness.js";
import {
  constant,
  hole,
  holePiece,
  record,
  sequence,
  string,
  text,
  textPiece,
  unbounded,
  type Value,
} from "./value.js";

function asString(value: Value): Extract<Value, { kind: "string" }> {
  if (value.kind !== "string") {
    throw new Error(`expected a string, got ${value.kind}`);
  }
  return value;
}

describe("everyOption", () => {
  it("settles when every option agrees, and not when they differ", () => {
    expect(everyOption([0, null, undefined, false], Boolean)).toBe(false);
    expect(everyOption([1, true], Boolean)).toBe(true);
    expect(everyOption([0, 1], Boolean)).toBeNull();
  });
});

describe("stringIsEmpty", () => {
  it("says an empty string is empty and one with settled text is not", () => {
    expect(stringIsEmpty(asString(text("")))).toBe(true);
    expect(
      stringIsEmpty(
        asString(string([textPiece(["/users/"]), holePiece("id")])),
      ),
    ).toBe(false);
  });

  it("cannot tell for a hole or a piece that may be empty", () => {
    expect(stringIsEmpty(asString(string([holePiece("id")])))).toBeNull();
    expect(stringIsEmpty(asString(string([textPiece(["a", ""])])))).toBeNull();
  });
});

describe("hasNoEntries", () => {
  it("counts the entries every path wrote", () => {
    expect(hasNoEntries({ kind: "sequence", items: [] })).toBe(true);
    const listed = sequence([constant(1)]);
    if (listed.kind !== "sequence") {
      throw new Error("expected a sequence");
    }
    expect(hasNoEntries(listed)).toBe(false);
  });

  it("cannot tell for a record code it cannot see may have changed", () => {
    const written = record([["id", constant(1)]], true);
    if (written.kind !== "record") {
      throw new Error("expected a record");
    }
    expect(hasNoEntries(written)).toBeNull();
  });

  it("cannot tell when only some paths wrote the entries", () => {
    expect(
      hasNoEntries({
        kind: "record",
        fields: new Map([["id", { value: constant(1), presence: "optional" }]]),
        open: false,
      }),
    ).toBeNull();
  });
});

describe("settledTest", () => {
  it("says what a condition comes to and why", () => {
    expect(
      settledTest(constant(false), () => record([]), testTruthiness),
    ).toEqual({
      truth: false,
      values: { type: "record", properties: {} },
      every: "truthy",
    });
  });

  it("gives nothing when the condition or its subject could go either way", () => {
    expect(settledTest(hole("x"), () => record([]), testTruthiness)).toBeNull();
    expect(
      settledTest(constant(true), () => hole("x"), testTruthiness),
    ).toBeNull();
  });
});

describe("the test language's rule", () => {
  it("counts every list and object as true and cannot tell for a reference", () => {
    expect(testTruthiness(sequence([]))).toBe(true);
    expect(testTruthiness(unbounded(hole("x")))).toBe(true);
    expect(testTruthiness({ kind: "ref", id: 0 })).toBeNull();
    expect(testTruthiness({ kind: "deferred", force: () => constant(1) })).toBe(
      true,
    );
  });
});

describe("opposite", () => {
  it("keeps null when there is nothing to turn around", () => {
    expect(opposite(null)).toBeNull();
    expect(opposite(true)).toBe(false);
  });
});
