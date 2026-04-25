import { describe, expect, it } from "vitest";

import {
  bodyAccessorsFor,
  readDeclaredContract,
  statusAccessorsFor,
} from "./declaredContract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function summary(
  http?: Record<string, unknown>,
  extraMetadata?: Record<string, unknown>,
): BehavioralSummary {
  const metadata: Record<string, unknown> = { ...(extraMetadata ?? {}) };
  if (http !== undefined) {
    metadata.http = http;
  }
  return {
    kind: "client",
    location: { file: "x.ts", range: { start: 1, end: 2 }, exportName: null },
    identity: { name: "x", exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

describe("statusAccessorsFor", () => {
  it("returns the historical names by default", () => {
    const result = statusAccessorsFor(summary());
    expect([...result].sort()).toEqual(["status", "statusCode"]);
  });

  it("uses the metadata names when present", () => {
    const result = statusAccessorsFor(
      summary({ statusAccessors: ["responseStatus", "code"] }),
    );
    expect([...result].sort()).toEqual(["code", "responseStatus"]);
  });

  it("falls back when metadata.http.statusAccessors is empty", () => {
    const result = statusAccessorsFor(summary({ statusAccessors: [] }));
    expect([...result].sort()).toEqual(["status", "statusCode"]);
  });

  it("ignores unscoped flat keys (migration guard)", () => {
    // A summary written pre-namespacing that still has the flat key should
    // NOT be honored — it's a signal the producer is out of date.
    const result = statusAccessorsFor(
      summary(undefined, { statusAccessors: ["responseStatus"] }),
    );
    expect([...result].sort()).toEqual(["status", "statusCode"]);
  });

  it("filters out non-string values defensively", () => {
    const result = statusAccessorsFor(
      summary({ statusAccessors: ["status", 42, null, "code"] }),
    );
    expect([...result].sort()).toEqual(["code", "status"]);
  });
});

describe("bodyAccessorsFor", () => {
  it("returns the historical name by default", () => {
    expect(bodyAccessorsFor(summary())).toEqual(["body"]);
  });

  it("uses the metadata names when present", () => {
    expect(bodyAccessorsFor(summary({ bodyAccessors: ["data"] }))).toEqual([
      "data",
    ]);
  });

  it("ignores unscoped flat bodyAccessors key", () => {
    expect(
      bodyAccessorsFor(summary(undefined, { bodyAccessors: ["data"] })),
    ).toEqual(["body"]);
  });
});

describe("readDeclaredContract", () => {
  it("returns null when metadata.http is absent", () => {
    expect(readDeclaredContract(summary())).toBeNull();
  });

  it("returns null when responses is not an array", () => {
    expect(
      readDeclaredContract(
        summary({ declaredContract: { responses: "nope" } }),
      ),
    ).toBeNull();
  });

  it("preserves valid response entries", () => {
    const contract = readDeclaredContract(
      summary({
        declaredContract: {
          responses: [
            { statusCode: 200, body: { type: "record", properties: {} } },
            { statusCode: 404, body: null },
            { statusCode: "bogus" },
          ],
        },
      }),
    );
    expect(contract?.responses).toEqual([
      { statusCode: 200, body: { type: "record", properties: {} } },
      { statusCode: 404, body: null },
    ]);
  });
});
