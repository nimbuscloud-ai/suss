// Unit tests for channel parsing and the subject-with-agreeing-bus
// pairing rule.

import { describe, expect, it } from "vitest";

import {
  addChannel,
  channelsPair,
  createChannelSet,
  hasPair,
  pairingOwners,
  parseChannel,
} from "./channelPairing.js";

describe("parseChannel", () => {
  it("reads a bus-qualified channel as a subject on a bus", () => {
    expect(parseChannel("default#order.placed")).toEqual({
      bus: "default",
      subject: "order.placed",
    });
  });

  it("reads a channel with no separator as a subject with no bus", () => {
    expect(parseChannel("order.placed")).toEqual({
      bus: null,
      subject: "order.placed",
    });
  });

  it("splits on the first separator only, keeping a subject that contains one", () => {
    expect(parseChannel("default#order#placed")).toEqual({
      bus: "default",
      subject: "order#placed",
    });
  });
});

describe("channelsPair", () => {
  it("pairs two channels that name the same subject on the same bus", () => {
    expect(channelsPair("default#order.placed", "default#order.placed")).toBe(
      true,
    );
  });

  it("pairs a bus-less subject with the same subject on any bus", () => {
    expect(channelsPair("order.placed", "default#order.placed")).toBe(true);
    expect(channelsPair("order.placed", "staging#order.placed")).toBe(true);
  });

  it("keeps two buses carrying the same subject apart", () => {
    expect(channelsPair("staging#order.placed", "default#order.placed")).toBe(
      false,
    );
  });

  it("pairs a queue logical id with itself and nothing else", () => {
    expect(channelsPair("OrdersQueue", "OrdersQueue")).toBe(true);
    expect(channelsPair("OrdersQueue", "ShipmentsQueue")).toBe(false);
  });

  it("compares a subject containing a separator whole", () => {
    expect(channelsPair("default#order#placed", "default#order#placed")).toBe(
      true,
    );
    expect(channelsPair("default#order#placed", "default#order")).toBe(false);
  });

  it("does not pair different subjects on the same bus", () => {
    expect(channelsPair("default#order.placed", "default#order.shipped")).toBe(
      false,
    );
  });
});

describe("hasPair", () => {
  it("finds a bus-qualified channel from a bus-less lookup and back", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    expect(hasPair(set, "order.placed")).toBe(true);
    expect(hasPair(set, "default#order.placed")).toBe(true);
    expect(hasPair(set, "staging#order.placed")).toBe(false);
  });

  it("answers false for a subject the set has never seen", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    expect(hasPair(set, "order.shipped")).toBe(false);
  });

  it("keeps every bus recorded for a subject two sides both publish", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    addChannel(set, "staging#order.placed", "orders::src/staging.ts::publish");
    expect(hasPair(set, "staging#order.placed")).toBe(true);
    expect(hasPair(set, "default#order.placed")).toBe(true);
  });
});

describe("pairingOwners", () => {
  it("says which summary put the channel that paired into the set", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    expect(pairingOwners(set, "order.placed")).toEqual([
      "orders::src/publish.ts::publish",
    ]);
  });

  it("leaves out an owner whose bus does not agree", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    addChannel(set, "staging#order.placed", "orders::src/staging.ts::publish");
    expect(pairingOwners(set, "staging#order.placed")).toEqual([
      "orders::src/staging.ts::publish",
    ]);
  });

  it("is empty for a subject the set has never seen", () => {
    const set = createChannelSet();
    addChannel(set, "default#order.placed", "orders::src/publish.ts::publish");
    expect(pairingOwners(set, "order.shipped")).toEqual([]);
  });
});

describe("what channel pairing takes for granted", () => {
  it("reads a separator in any channel string as a bus in front of a subject", () => {
    expect(channelsPair("orders#priority", "priority")).toBe(true);
  });

  it("lets a channel with no bus stated pair with that subject on every bus", () => {
    const set = createChannelSet();
    addChannel(set, "prod#order.placed", "orders::src/prod.ts::publish");
    addChannel(set, "staging#order.placed", "orders::src/staging.ts::publish");

    expect(pairingOwners(set, "order.placed")).toHaveLength(2);
  });
});
