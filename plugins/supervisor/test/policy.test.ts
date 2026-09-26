import { describe, expect, it } from "vitest";

import {
  blocksStop,
  editResult,
  mergeResults,
  WAIT_FOR_STOP,
} from "../scripts/policy.mjs";

import type { SinceFinding, SinceReport } from "../scripts/types.js";

function finding(overrides: Partial<SinceFinding> = {}): SinceFinding {
  return {
    kind: "unhandledProviderCase",
    boundary: {
      transport: "http",
      semantics: { name: "rest", method: "POST", path: "/orders" },
      recognition: "express",
    },
    provider: {
      summary: "src/orders/create.ts::post",
      transitionId: "post:response:409:4b7ea21",
      location: {
        file: "src/orders/create.ts",
        range: { start: 10, end: 23 },
        exportName: "post",
      },
    },
    consumer: {
      summary: "web/orders/submitOrder.ts::submitOrder",
      location: {
        file: "web/orders/submitOrder.ts",
        range: { start: 1, end: 13 },
        exportName: "submitOrder",
      },
    },
    description:
      "Provider produces status 409 but no consumer branch handles it",
    severity: "warning",
    identity: "409-at-orders",
    boundaryKey: "POST /orders",
    atChangedBoundary: true,
    ...overrides,
  };
}

function report(
  findings: SinceFinding[],
  resolved: SinceFinding[] = [],
): SinceReport {
  return {
    since: "/tmp/before",
    findings,
    resolved,
    changedBoundaries: [
      { key: "POST /orders", units: ["src/orders/create.ts::post"] },
    ],
    run: [],
  };
}

describe("what an edit's result passes on", () => {
  it("passes on a new warning at a boundary the edit changed", () => {
    const result = editResult(report([finding()]), 3);

    expect(result.blocking.map((f) => f.identity)).toEqual(["409-at-orders"]);
    expect(result.covers).toBe(3);
  });

  it("holds back a new warning at a boundary the edit did not change", () => {
    const ripple = finding({ atChangedBoundary: false });

    expect(editResult(report([ripple]), 1).blocking).toEqual([]);
  });

  it("passes on a new error wherever it is", () => {
    const error = finding({ severity: "error", atChangedBoundary: false });

    expect(editResult(report([error]), 1).blocking).toEqual([error]);
  });

  it("holds back info, whatever the boundary", () => {
    const info = finding({ severity: "info" });

    expect(editResult(report([info]), 1).blocking).toEqual([]);
  });

  it("holds back the kinds the agent's next edit usually settles", () => {
    for (const kind of WAIT_FOR_STOP) {
      const early = finding({
        kind: kind as SinceFinding["kind"],
        severity: "error",
      });

      expect(editResult(report([early]), 1).blocking).toEqual([]);
    }
  });

  it("drops a finding a .sussignore rule marks, and keeps one it downgrades", () => {
    const marked = finding({
      identity: "marked",
      suppressed: { reason: "accepted", effect: "mark" },
    });
    const downgraded = finding({
      identity: "downgraded",
      severity: "warning",
      suppressed: {
        reason: "lower",
        effect: "downgrade",
        originalSeverity: "error",
      },
    });

    const result = editResult(report([marked, downgraded]), 1);

    expect(result.blocking.map((f) => f.identity)).toEqual(["downgraded"]);
  });
});

describe("results delivered together", () => {
  it("drops a finding one edit introduced and a later edit resolved", () => {
    const introduced = editResult(report([finding()]), 1);
    const fixed = editResult(report([], [finding()]), 2);

    const merged = mergeResults([introduced, fixed]);

    expect(merged.blocking).toEqual([]);
    expect(merged.resolved).toEqual([]);
    expect(merged.covers).toBe(2);
    expect(merged.changed.map((b) => b.key)).toEqual(["POST /orders"]);
  });
});

describe("what a stop blocks on", () => {
  it("blocks on each new error once", () => {
    const error = finding({ severity: "error", identity: "e1" });
    const warning = finding({ identity: "w1" });

    expect(blocksStop([error, warning], new Set())).toEqual([error]);
    expect(blocksStop([error, warning], new Set(["e1"]))).toEqual([]);
  });
});
