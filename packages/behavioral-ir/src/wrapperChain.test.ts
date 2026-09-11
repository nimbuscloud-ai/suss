import { describe, expect, it } from "vitest";

import { withWrapperMetadata } from "./metadata.js";
import { wrapperChain, wrapperIndex } from "./wrapperChain.js";

import type { BehavioralSummary } from "./index.js";

function unit(name: string, file: string, line: number): BehavioralSummary {
  return {
    kind: "middleware",
    location: { file, range: { start: line, end: line + 5 } },
    identity: { name, exportPath: [name], boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("wrapperIndex", () => {
  const first = unit("use", "src/app.ts", 3);
  const second = unit("use", "src/app.ts", 9);
  const index = wrapperIndex([first, second]);

  it("takes the one that starts on the line the reference gives", () => {
    expect(index.find({ file: "src/app.ts", name: "use", line: 9 })).toBe(
      second,
    );
  });

  it("takes the first of that name when the reference gives no line", () => {
    expect(index.find({ file: "src/app.ts", name: "use" })).toBe(first);
  });

  it("falls back to the first when no summary starts on that line", () => {
    expect(index.find({ file: "src/app.ts", name: "use", line: 40 })).toBe(
      first,
    );
  });

  it("finds nothing for a file the run has no summaries from", () => {
    expect(index.find({ file: "src/other.ts", name: "use" })).toBeUndefined();
  });
});

describe("wrapperChain", () => {
  it("gives the wrappers a unit records, in the order they run", () => {
    const applied = [
      { file: "src/a.ts", name: "outer" },
      { file: "src/b.ts", name: "inner" },
    ];
    const route: BehavioralSummary = {
      ...unit("route", "src/routes.ts", 1),
      metadata: withWrapperMetadata(undefined, { applied }),
    };

    expect(wrapperChain(route)).toEqual(applied);
  });

  it("gives nothing for a unit with no wrappers", () => {
    expect(wrapperChain(unit("route", "src/routes.ts", 1))).toEqual([]);
  });
});
