import { describe, expect, it } from "vitest";

import { splitTimeReport } from "./measure.js";
import { boundaryCounts, summariseCheck, summariseDiff } from "./report.js";

describe("boundaryCounts", () => {
  it("reads the compared line", () => {
    expect(boundaryCounts("Compared 7 of 608 boundaries.\n")).toEqual({
      paired: 7,
      total: 608,
    });
  });

  it("reads a run that compared nothing", () => {
    const text =
      "Nothing was compared.\n\n  313 boundaries had nothing to pair with, so nothing was checked.";

    expect(boundaryCounts(text)).toEqual({ paired: 0, total: 313 });
  });

  it("says it does not know when the text has neither line", () => {
    expect(boundaryCounts("error: usage")).toEqual({
      paired: null,
      total: null,
    });
  });
});

describe("summariseCheck", () => {
  it("counts findings by kind and unpaired boundaries by key", () => {
    const counts = summariseCheck(
      {
        findings: [
          { kind: "unhandledProviderCase", severity: "warning" },
          { kind: "unhandledProviderCase", severity: "warning" },
        ],
        run: [],
        pairs: [{}],
        unmatched: {
          providers: [
            { key: "GET /orders" },
            { key: "GET /orders" },
            { key: "POST /orders" },
          ],
          consumers: [],
          unpairable: [{ key: null, reason: "noBoundary" }],
        },
        summariesWithGaps: 3,
      },
      "Compared 1 of 3 boundaries.",
    );

    expect(counts.findings).toEqual({ unhandledProviderCase: 2 });
    expect(counts.unpairedProviderBoundaries).toBe(2);
    expect(counts.unpairable).toEqual({ noBoundary: 1 });
    expect(counts.paired).toBe(1);
  });
});

describe("summariseDiff", () => {
  it("reads the diff report and flags output that is not JSON", () => {
    expect(summariseDiff('{"changed":2,"boundaries":[{}]}')).toEqual({
      changedSummaries: 2,
      changedBoundaries: 1,
      parsed: true,
    });
    expect(summariseDiff("error").parsed).toBe(false);
  });
});

describe("splitTimeReport", () => {
  it("separates the command's stderr from the report time appends", () => {
    const raw = [
      "Wrote 3 summaries",
      "        2.08 real         2.50 user         0.30 sys",
      "           368967680  maximum resident set size",
      "                   0  average shared memory size",
    ].join("\n");

    expect(splitTimeReport(raw)).toEqual({
      stderr: "Wrote 3 summaries\n",
      peakRssBytes: 368967680,
    });
  });
});
