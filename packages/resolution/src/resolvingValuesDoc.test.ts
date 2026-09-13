// The rule counts docs/resolving-values.md quotes, checked against the
// rule list itself rather than trusting a number someone moved by hand.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RESOLUTION_RULES } from "./index.js";

const DOC_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "resolving-values.md",
);

/** "<N> rules ... <M> of them derive stepsTo", however the words around the numbers read. */
const RULE_COUNTS =
  /(\d+)\s+rules[\s\S]{0,80}?(\d+)\s+of them derive `?stepsTo/g;

describe("docs/resolving-values.md", () => {
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
});
