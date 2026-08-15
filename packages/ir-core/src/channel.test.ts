import { describe, expect, it } from "vitest";

import {
  busesAgree,
  channelsPair,
  formatChannel,
  parseChannel,
} from "./channel.js";

describe("parseChannel", () => {
  it("reads a bus off a qualified channel", () => {
    expect(parseChannel("default#order.placed")).toEqual({
      bus: "default",
      subject: "order.placed",
    });
  });

  it("leaves the subject whole when no bus is written", () => {
    expect(parseChannel("OrdersQueue")).toEqual({
      bus: null,
      subject: "OrdersQueue",
    });
  });

  it("splits on the first separator and keeps the rest", () => {
    // A subject that contains its own separator is compared whole,
    // rather than cut into pieces that pair with the wrong things.
    expect(parseChannel("default#order#placed")).toEqual({
      bus: "default",
      subject: "order#placed",
    });
  });

  it("reads an empty bus as written", () => {
    expect(parseChannel("#order.placed")).toEqual({
      bus: "",
      subject: "order.placed",
    });
  });
});

describe("busesAgree", () => {
  it("agrees when both name the same bus", () => {
    expect(busesAgree("default", "default")).toBe(true);
  });

  it("agrees when either side does not know its bus", () => {
    expect(busesAgree("default", null)).toBe(true);
    expect(busesAgree(null, "default")).toBe(true);
    expect(busesAgree(null, null)).toBe(true);
  });

  it("does not agree when two sides name different buses", () => {
    expect(busesAgree("default", "staging")).toBe(false);
  });
});

describe("channelsPair", () => {
  it("pairs two channels on the same bus", () => {
    expect(channelsPair("default#order.placed", "default#order.placed")).toBe(
      true,
    );
  });

  it("pairs a qualified channel with a bare subject", () => {
    // The code side reads its subject off a handler's config and never
    // learns which bus reaches it.
    expect(channelsPair("default#order.placed", "order.placed")).toBe(true);
  });

  it("keeps two buses apart when both are named and differ", () => {
    expect(channelsPair("default#order.placed", "staging#order.placed")).toBe(
      false,
    );
  });

  it("pairs a queue logical id with itself", () => {
    expect(channelsPair("OrdersQueue", "OrdersQueue")).toBe(true);
  });

  it("does not pair two subjects that differ", () => {
    expect(channelsPair("default#order.placed", "default#order.shipped")).toBe(
      false,
    );
  });

  it("keeps subject case, since a bus compares its subjects byte for byte", () => {
    expect(channelsPair("order.placed", "Order.Placed")).toBe(false);
  });
});

describe("formatChannel", () => {
  it("writes a bus and a subject in the form parseChannel reads", () => {
    expect(formatChannel("default", "order.placed")).toBe(
      "default#order.placed",
    );
    expect(parseChannel(formatChannel("default", "order.placed"))).toEqual({
      bus: "default",
      subject: "order.placed",
    });
  });

  it("writes the subject alone for a side that does not know its bus", () => {
    expect(formatChannel(null, "OrdersQueue")).toBe("OrdersQueue");
  });
});

describe("the channel brand", () => {
  it("refuses a hand-assembled channel at the type level", () => {
    // @ts-expect-error only formatChannel mints the brand
    const wrong: Channel = "orders#order.placed";
    expect(wrong).toBeDefined();
  });
});
