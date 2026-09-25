// The counts docs/theory/resolving-values.md quotes, checked against the rule
// lists themselves rather than trusting a number someone moved by hand.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "./index.js";

const DOC_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "theory",
  "resolving-values.md",
);

/** "<N> rules ... <M> of them derive stepsTo", however the words around the numbers read. */
const RULE_COUNTS =
  /(\d+)\s+rules[\s\S]{0,80}?(\d+)\s+of them derive `?stepsTo/g;

const QUESTION_COUNTS =
  /(\d+)\s+question\s+rules\s+feeding\s+(\d+)\s+answer\s+relations/g;

describe("docs/theory/resolving-values.md", () => {
  it("quotes the rule count and the stepsTo count the source actually has", () => {
    const doc = fs.readFileSync(DOC_PATH, "utf8");
    const matches = [...doc.matchAll(RULE_COUNTS)];
    const stepsToRules = RESOLUTION_RULES.filter(
      (rule) => rule.head.relation === "stepsTo",
    );

    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(Number(match[1])).toBe(RESOLUTION_RULES.length);
      expect(Number(match[2])).toBe(stepsToRules.length);
    }
  });

  it("quotes the question count and the answer relation count the source has", () => {
    const doc = fs.readFileSync(DOC_PATH, "utf8");
    const matches = [...doc.matchAll(QUESTION_COUNTS)];

    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(Number(match[1])).toBe(RESOLUTION_QUESTIONS.length);
      expect(Number(match[2])).toBe(ANSWER_RELATIONS.length);
    }
  });
});
