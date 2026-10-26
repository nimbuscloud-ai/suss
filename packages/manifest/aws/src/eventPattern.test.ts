import { describe, expect, it } from "vitest";

import { readEventPattern, resolveEventBusToken } from "./eventPattern.js";

describe("readEventPattern", () => {
  it("reads literal detail-type and source lists", () => {
    expect(
      readEventPattern({
        source: ["orders"],
        "detail-type": ["order.placed", "order.paid"],
      }),
    ).toEqual({
      detailTypes: ["order.placed", "order.paid"],
      sources: ["orders"],
      unsettled: [],
      filtersOtherFields: false,
      emittedByAws: false,
    });
  });

  it("gives null when the rule declares no pattern", () => {
    expect(readEventPattern(undefined)).toBeNull();
  });

  it("leaves out a field the pattern does not filter on", () => {
    expect(readEventPattern({ source: ["orders"] })).toEqual({
      sources: ["orders"],
      unsettled: [],
      filtersOtherFields: false,
      emittedByAws: false,
    });
  });

  it("says when the pattern also filters on a field a send does not state", () => {
    expect(
      readEventPattern({
        "detail-type": ["order.placed"],
        detail: { status: ["paid"] },
      })?.filtersOtherFields,
    ).toBe(true);
  });

  it("lists a field filtered with a prefix as unsettled", () => {
    expect(
      readEventPattern({
        "detail-type": [{ prefix: "order." }],
        source: [{ prefix: "com." }],
      }),
    ).toEqual({
      unsettled: ["detail-type", "source"],
      filtersOtherFields: false,
      emittedByAws: false,
    });
  });

  it("lists a bare string or an empty list as unsettled", () => {
    expect(
      readEventPattern({ "detail-type": "order.placed", source: [] })
        ?.unsettled,
    ).toEqual(["detail-type", "source"]);
  });

  it("says when AWS services send the events a source matches", () => {
    expect(
      readEventPattern({ source: ["aws.s3", "orders"] })?.emittedByAws,
    ).toBe(true);
  });
});

describe("resolveEventBusToken", () => {
  it("answers default when the bus is unnamed", () => {
    expect(resolveEventBusToken(undefined)).toBe("default");
  });

  it("answers the logical id for a Ref", () => {
    expect(resolveEventBusToken({ Ref: "OrdersBus" })).toBe("OrdersBus");
  });

  it("segments an event-bus ARN down to its name", () => {
    expect(
      resolveEventBusToken(
        "arn:aws:events:us-east-1:123456789012:event-bus/orders",
      ),
    ).toBe("orders");
  });

  it("keeps a literal bus name", () => {
    expect(resolveEventBusToken("orders")).toBe("orders");
  });

  it("answers default for a value that names no bus at all", () => {
    expect(resolveEventBusToken(42)).toBe("default");
  });
});
