import { describe, expect, it } from "vitest";

import { goesThroughRelation, OWN_BINDING, relationsOf } from "./relations.js";

import type { Interaction } from "./relations.js";

describe("relationsOf", () => {
  it("reads a query and writes a mutation", () => {
    const read: Interaction = {
      class: "storage-access",
      kind: "read",
      fields: ["id"],
    };
    const write: Interaction = {
      class: "storage-access",
      kind: "write",
      fields: ["id"],
    };

    expect(relationsOf(read)).toEqual(["reads"]);
    expect(relationsOf(write)).toEqual(["writes"]);
  });

  it("both reads and writes a service call, which sends and gets back", () => {
    expect(relationsOf({ class: "service-call", method: "GET" })).toEqual([
      "reads",
      "writes",
    ]);
  });

  it("writes a send and reads a receive", () => {
    expect(relationsOf({ class: "message-send" })).toEqual(["writes"]);
    expect(relationsOf({ class: "message-receive" })).toEqual(["reads"]);
  });

  it("both reads and writes an invoke, which hands a payload over and takes a result back", () => {
    expect(relationsOf({ class: "unit-invoke" })).toEqual(["reads", "writes"]);
  });

  it("reads a config read", () => {
    expect(
      relationsOf({ class: "config-read", name: "PORT", defaulted: false }),
    ).toEqual(["reads"]);
  });

  it("gives a scheduled callback neither, since it crosses no boundary", () => {
    expect(
      relationsOf({
        class: "schedule",
        via: "setTimeout",
        callbackRef: { type: "literal" },
        hasDelay: true,
      }),
    ).toEqual([]);
  });
});

describe("OWN_BINDING", () => {
  it("has a provider serving its boundary and a consumer going through one", () => {
    expect(OWN_BINDING.provider).toEqual(["provides"]);
    expect(OWN_BINDING.consumer).toEqual(["reads", "writes"]);
  });
});

describe("goesThroughRelation", () => {
  it("is true only of a storage access written under a relation", () => {
    expect(
      goesThroughRelation({
        class: "storage-access",
        kind: "read",
        fields: [],
        relationPath: ["author"],
      }),
    ).toBe(true);
    expect(
      goesThroughRelation({
        class: "storage-access",
        kind: "read",
        fields: [],
      }),
    ).toBe(false);
    expect(goesThroughRelation({ class: "message-send" })).toBe(false);
  });
});
