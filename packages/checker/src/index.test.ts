import { describe, expect, it } from "vitest";

import { checkPair } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function emptySummary(name: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/${name}.ts`,
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: { name, exportPath: [name], boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkPair", () => {
  it("returns an empty finding list for two empty summaries", () => {
    const provider = emptySummary("provider");
    const consumer = emptySummary("consumer");
    expect(checkPair(provider, consumer)).toEqual([]);
  });
});
