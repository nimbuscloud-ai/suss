import { describe, expect, it } from "vitest";

import {
  decidesResponse,
  placesInResponse,
  readShapeOf,
} from "./responseReads.js";

import type { Predicate, StatusMembers } from "@suss/behavioral-ir";
import type { RawCondition } from "./index.js";
import type { ReadHop, ReadStop, ResponseReading } from "./responseReads.js";

/**
 * A made-up program: `request` is the call, a node named `x.m` is the
 * member `m` of `x`, and every other node's walk ends where `walks` says.
 */
function reading(
  walks: Record<string, ReadStop<string>[]>,
  asked: string[][] = [],
): ResponseReading<string> {
  return {
    idOf: (node) => node,
    stopsOf: (values) => {
      asked.push([...values]);
      return new Map(values.map((value) => [value, walks[value] ?? []]));
    },
    isRequest: (node) => node === "request",
    hopOf: (node): ReadHop<string> | null => {
      const dot = node.lastIndexOf(".");
      return dot === -1
        ? null
        : { from: node.slice(0, dot), segments: [node.slice(dot + 1)] };
    },
  };
}

describe("placesInResponse", () => {
  it("follows a name to the member of the response it was written as", () => {
    const placeOf = placesInResponse(
      ["invoice"],
      reading({
        res: [{ node: "request", path: [] }],
        invoice: [{ node: "res.json", path: ["payer"] }],
      }),
    );

    expect(placeOf("invoice")).toEqual(["json", "payer"]);
  });

  it("asks the walk once for every name the given values lead to", () => {
    const asked: string[][] = [];
    const placeOf = placesInResponse(
      ["invoice.total", "receipt.total"],
      reading(
        {
          invoice: [{ node: "request", path: [] }],
          receipt: [{ node: "request", path: [] }],
        },
        asked,
      ),
    );

    expect([
      placeOf("invoice.total"),
      placeOf("receipt.total"),
      placeOf("invoice.total"),
    ]).toEqual([["total"], ["total"], ["total"]]);
    expect(asked).toEqual([["invoice", "receipt"]]);
  });

  it("places a value one of whose walks ends somewhere else", () => {
    const placeOf = placesInResponse(
      ["body"],
      reading({
        body: [
          { node: "request", path: ["data"] },
          { node: "fallback", path: [] },
        ],
      }),
    );

    expect(placeOf("body")).toEqual(["data"]);
  });

  it("leaves a value unplaced when its walks reach two places in the response", () => {
    const placeOf = placesInResponse(
      ["either"],
      reading({
        either: [
          { node: "request", path: ["first"] },
          { node: "request", path: ["second"] },
        ],
      }),
    );

    expect(placeOf("either")).toBeNull();
  });

  it("leaves a value unplaced when its walk reaches no request", () => {
    const placeOf = placesInResponse(
      ["cached"],
      reading({ cached: [{ node: "store", path: [] }] }),
    );

    expect(placeOf("cached")).toBeNull();
  });

  it("stops at a name whose walk comes back to itself", () => {
    const placeOf = placesInResponse(
      ["loop"],
      reading({ loop: [{ node: "loop.next", path: [] }] }),
    );

    expect(placeOf("loop")).toBeNull();
  });

  it("places a member of the request without asking the walk", () => {
    const asked: string[][] = [];
    const placeOf = placesInResponse(["request.json"], reading({}, asked));

    expect(placeOf("request.json")).toEqual(["json"]);
    expect(asked).toEqual([]);
  });

  it("gives up on a value more steps from the request than it follows", () => {
    const deep = ["res", ..."abcdefghij"].join(".");
    const placeOf = placesInResponse(
      [deep],
      reading({ res: [{ node: "request", path: [] }] }),
    );

    expect(placeOf(deep)).toBeNull();
  });

  it("ends a walk at the request and at a step, and nowhere else", () => {
    const ends: Record<string, boolean> = {};
    const base = reading({ invoice: [{ node: "request", path: [] }] });
    const placeOf = placesInResponse(["invoice"], {
      ...base,
      stopsOf: (values, endsAt) => {
        for (const node of ["request", "res.json", "store"]) {
          ends[node] = endsAt(node);
        }
        return base.stopsOf(values, endsAt);
      },
    });

    expect(placeOf("invoice")).toEqual([]);
    expect(ends).toEqual({ request: true, "res.json": true, store: false });
  });
});

describe("decidesResponse", () => {
  const members: StatusMembers = {
    members: new Set(["status", "ok"]),
    body: new Set(["json"]),
  };
  const guard = (structured: Predicate | null): RawCondition => ({
    sourceText: "guard",
    structured,
    polarity: "positive",
    source: "explicit",
  });
  const read = (property: string): Predicate => ({
    type: "truthinessCheck",
    subject: {
      type: "derived",
      from: { type: "dependency", name: "res", accessChain: [] },
      derivation: { type: "propertyAccess", property },
    },
    negated: false,
  });

  it("picks a test on a status member, and one nobody could parse", () => {
    const decides = decidesResponse(members);
    expect(decides(guard(read("ok")))).toBe(true);
    expect(decides(guard(null))).toBe(true);
    expect(decides(guard(read("exists")))).toBe(false);
  });
});

describe("readShapeOf", () => {
  it("nests reads that share a member, with each field unknown", () => {
    expect(
      readShapeOf([
        ["json", "payer", "name"],
        ["json", "total"],
        ["json", "payer"],
      ]),
    ).toEqual({
      type: "record",
      properties: {
        json: {
          type: "record",
          properties: {
            total: { type: "unknown" },
            payer: {
              type: "record",
              properties: { name: { type: "unknown" } },
            },
          },
        },
      },
    });
  });

  it("is null when nothing was read", () => {
    expect(readShapeOf([[]])).toBeNull();
  });
});
