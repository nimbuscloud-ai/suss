import { describe, expect, it } from "vitest";

import { metricBinding } from "@suss/behavioral-ir";

import { checkAll } from "../index.js";
import { checkMetric } from "./metricPairing.js";

import type {
  BehavioralSummary,
  MetricContractMetadata,
  MetricReadingMetadata,
} from "@suss/behavioral-ir";

const SYSTEM = "test-monitoring";
const SERIES = "example.test/counters/refusals";

function declares(
  contract: MetricContractMetadata,
  metricType: string = SERIES,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "signals.tf",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: "counter.refusals",
      exportPath: null,
      boundaryBinding: metricBinding({
        recognition: "test",
        metricSystem: SYSTEM,
        metricType,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: { metricContract: contract },
  };
}

function reads(
  reading: MetricReadingMetadata,
  metricType: string | null = SERIES,
): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: "alerts.tf",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: "watch.refusals_climbing",
      exportPath: null,
      boundaryBinding: metricBinding({
        recognition: "test",
        metricSystem: SYSTEM,
        metricType,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: { metricReading: reading },
  };
}

describe("a reading compared against a shape the series does not produce", () => {
  it("is an error, and says which setting would reduce it", () => {
    const findings = checkMetric([
      declares({ values: "histogram" }),
      reads({
        comparesTo: "number",
        reduction: {
          setting: "window.reducer",
          leaves: {
            MEDIAN: "number",
            P95: "number",
            EVERY_BUCKET: "histogram",
          },
        },
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "boundaryShapeMismatch",
      aspect: "read",
      severity: "error",
    });
    expect(findings[0]?.description).toContain("a histogram of buckets");
    expect(findings[0]?.description).toContain("window.reducer");
    expect(findings[0]?.description).toContain("MEDIAN, P95");
    // A reducer that leaves the histogram alone is no way out of this.
    expect(findings[0]?.description).not.toContain("EVERY_BUCKET");
  });

  it("still reports when nobody said how a reduction is written", () => {
    const findings = checkMetric([
      declares({ values: "histogram" }),
      reads({ comparesTo: "number" }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).not.toContain("unless");
  });

  it("says nothing once the reading reduces to what it compares", () => {
    expect(
      checkMetric([
        declares({ values: "histogram" }),
        reads({ comparesTo: "number", reducesTo: "number" }),
      ]),
    ).toEqual([]);
  });

  it("says nothing when the series already measures what it compares", () => {
    expect(
      checkMetric([
        declares({ values: "number", accumulates: "gauge" }),
        reads({ comparesTo: "number" }),
      ]),
    ).toEqual([]);
  });
});

describe("what the pass declines to judge", () => {
  it("makes no claim when the declaring side did not say what it measures", () => {
    expect(
      checkMetric([
        declares({ accumulates: "cumulative" }),
        reads({ comparesTo: "number" }),
      ]),
    ).toEqual([]);
  });

  it("makes no claim when the reading compares nothing", () => {
    expect(
      checkMetric([
        declares({ values: "histogram" }),
        reads({ reducesTo: "histogram" }),
      ]),
    ).toEqual([]);
  });

  it("leaves alone a reading of a metric nothing in the run declares", () => {
    expect(
      checkMetric([
        declares({ values: "histogram" }, "example.test/counters/other"),
        reads({ comparesTo: "number" }),
      ]),
    ).toEqual([]);
  });

  it("pairs a reading that named no metric with nothing", () => {
    expect(
      checkMetric([
        declares({ values: "histogram" }),
        reads({ comparesTo: "number" }, null),
      ]),
    ).toEqual([]);
  });

  it("keeps two monitoring systems apart", () => {
    const elsewhere = declares({ values: "histogram" });
    elsewhere.identity.boundaryBinding = metricBinding({
      recognition: "test",
      metricSystem: "other-monitoring",
      metricType: SERIES,
    });

    expect(checkMetric([elsewhere, reads({ comparesTo: "number" })])).toEqual(
      [],
    );
  });
});

describe("what metric pairing takes for granted", () => {
  it("treats the system and the type string as the whole identity", () => {
    const findings = checkMetric([
      declares({ values: "histogram" }),
      declares({ values: "number" }),
      reads({ comparesTo: "number" }),
    ]);

    expect(findings).toEqual([]);
  });

  it("compares what a series measures and not how it accumulates", () => {
    expect(
      checkMetric([
        declares({ values: "number", accumulates: "cumulative" }),
        reads({ comparesTo: "number" }),
      ]),
    ).toEqual([]);
  });
});

describe("the pair reaching the report", () => {
  it("is recorded by the generic pairing pass, not by this one", () => {
    const summaries = [
      declares({ values: "histogram" }),
      reads({ comparesTo: "number" }),
    ];

    const result = checkAll(summaries);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.key).toContain(SERIES);
    expect(result.findings.map((f) => f.kind)).toEqual([
      "boundaryShapeMismatch",
    ]);
  });
});
