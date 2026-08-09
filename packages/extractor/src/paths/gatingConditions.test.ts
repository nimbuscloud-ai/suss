import { describe, expect, it } from "vitest";

import { sharedGatingConditions } from "./gatingConditions.js";

import type { ConditionInfo } from "./structuredStatement.js";

const condition = (
  sourceText: string,
  polarity: "positive" | "negative" = "positive",
): ConditionInfo<null> => ({
  sourceText,
  polarity,
  source: "explicit",
  expression: null,
});

describe("what every path to a terminal agrees on", () => {
  it("claims nothing when nobody reached the terminal", () => {
    expect(sharedGatingConditions(undefined)).toEqual([]);
    expect(sharedGatingConditions([])).toEqual([]);
  });

  it("keeps the conditions of a terminal reached one way", () => {
    expect(sharedGatingConditions([[condition("a")]])).toEqual([
      {
        sourceText: "a",
        structured: null,
        polarity: "positive",
        source: "explicit",
      },
    ]);
  });

  it("keeps only what two paths share", () => {
    const paths = [
      [condition("a"), condition("b")],
      [condition("a"), condition("c")],
    ];
    expect(sharedGatingConditions(paths).map((c) => c.sourceText)).toEqual([
      "a",
    ]);
  });

  it("treats one test and its negation as different conditions", () => {
    const paths = [[condition("a")], [condition("a", "negative")]];
    expect(sharedGatingConditions(paths)).toEqual([]);
  });

  it("claims nothing when one path is unconditional", () => {
    expect(sharedGatingConditions([[condition("a")], []])).toEqual([]);
  });

  it("leaves the predicate unparsed, since the engine never read one", () => {
    const [only] = sharedGatingConditions([[condition("a")]]);
    expect(only?.structured).toBeNull();
  });
});
