import { describe, expect, it } from "vitest";

import { gapCaveats } from "./askCaveats.js";

import type { BehavioralSummary, Gap } from "@suss/behavioral-ir";

function summaryWith(
  name: string,
  line: number,
  gaps: Gap[],
): BehavioralSummary {
  return {
    kind: "endpoint",
    location: { file: "src/dao.ts", range: { start: line, end: line } },
    identity: { name },
    inputs: [],
    transitions: [],
    interactions: [],
    gaps,
  } as unknown as BehavioralSummary;
}

const unfollowed = (callee?: string): Gap => ({
  type: "unfollowedCall",
  conditions: [],
  consequence: "unknown",
  description: "long prose nobody should have to read twice",
  ...(callee !== undefined ? { callee } : {}),
});

describe("gapCaveats", () => {
  it("prints one warning line per unit in file:line form", () => {
    const lines = gapCaveats([
      summaryWith("byPublication", 30, [unfollowed("loadCursor")]),
    ]);
    expect(lines).toEqual([
      "warning: src/dao.ts:30 byPublication: unfollowed call to loadCursor",
    ]);
  });

  it("folds a unit's gaps into one line without repeating phrases", () => {
    const lines = gapCaveats([
      summaryWith("byPublication", 30, [
        unfollowed("loadCursor"),
        unfollowed(),
        {
          type: "unreadOutcome",
          conditions: [],
          consequence: "unknown",
          description: "prose",
        },
        {
          type: "unhandledCase",
          conditions: [],
          consequence: "unknown",
          description: "prose",
        },
      ]),
    ]);
    expect(lines).toEqual([
      "warning: src/dao.ts:30 byPublication: unfollowed call to loadCursor, an unfollowed call, an outcome this run did not read, an unhandled case",
    ]);
  });

  it("caps the list and says how many units it left out", () => {
    const lines = gapCaveats(
      Array.from({ length: 12 }, (_, i) =>
        summaryWith(`fn${i}`, i, [unfollowed("x")]),
      ),
    );
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe(
      "warning: 4 more units record gaps. Run with --json to see every gap.",
    );
  });

  it("says nothing when no unit records a gap", () => {
    expect(gapCaveats([summaryWith("clean", 1, [])])).toEqual([]);
  });
});
