import { describe, expect, it } from "vitest";

import { readMessageBusMetadata, withMessageBusMetadata } from "./index.js";

import type { BehavioralSummary } from "./index.js";

function summaryWith(
  metadata: Record<string, unknown> | undefined,
): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: "OrderConsumer",
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("the messageBus metadata namespace", () => {
  it("round-trips what a writer sets", () => {
    const metadata = withMessageBusMetadata(
      { codeScope: { kind: "codeUri", path: "src/consumer/" } },
      { queue: "OrdersQueue", patternResolution: "exact" },
    );
    const read = readMessageBusMetadata(summaryWith(metadata));
    expect(read?.queue).toBe("OrdersQueue");
    expect(read?.patternResolution).toBe("exact");
    // Neighboring namespaces survive the merge.
    expect(metadata.codeScope).toEqual({
      kind: "codeUri",
      path: "src/consumer/",
    });
  });

  it("answers undefined for an absent or unreadable entry", () => {
    expect(readMessageBusMetadata(summaryWith(undefined))).toBeUndefined();
    expect(
      readMessageBusMetadata(
        summaryWith({ messageBus: { patternResolution: 42 } }),
      ),
    ).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withMessageBusMetadata(undefined, {
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        queueLogicalId: "OrdersQueue",
      }),
    ).toThrow();
  });
});
