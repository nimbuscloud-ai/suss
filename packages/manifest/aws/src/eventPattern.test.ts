import { describe, expect, it } from "vitest";

import { reduceEventPattern, resolveEventBusToken } from "./eventPattern.js";

describe("reduceEventPattern", () => {
  it("reduces a literal detail-type array to its entries", () => {
    expect(
      reduceEventPattern({ "detail-type": ["order.placed", "order.paid"] }),
    ).toEqual({ kind: "exact", detailTypes: ["order.placed", "order.paid"] });
  });

  it("is unresolvable when the pattern is absent", () => {
    const reduction = reduceEventPattern(undefined);
    expect(reduction.kind).toBe("unresolvable");
  });

  it("is unresolvable when detail-type is missing", () => {
    const reduction = reduceEventPattern({ source: ["orders"] });
    expect(reduction.kind).toBe("unresolvable");
  });

  it("is unresolvable when detail-type holds a content filter", () => {
    const reduction = reduceEventPattern({
      "detail-type": [{ prefix: "order." }],
    });
    expect(reduction.kind).toBe("unresolvable");
  });

  it("is unresolvable when detail-type is a bare string rather than a list", () => {
    const reduction = reduceEventPattern({ "detail-type": "order.placed" });
    expect(reduction.kind).toBe("unresolvable");
  });

  it("is unresolvable when detail-type is empty", () => {
    const reduction = reduceEventPattern({ "detail-type": [] });
    expect(reduction.kind).toBe("unresolvable");
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
