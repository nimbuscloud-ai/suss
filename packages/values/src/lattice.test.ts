import { describe, expect, it } from "vitest";

import { join, joinAll, joinRange, sameValue, widen } from "./lattice.js";
import {
  constant,
  hole,
  holePiece,
  type Item,
  record,
  sequence,
  string,
  text,
  textPiece,
  unbounded,
  type Value,
} from "./value.js";

function optional(value: Value): Item {
  return { value, presence: "optional" };
}

describe("join", () => {
  it("keeps the shared prefix and suffix of two strings", () => {
    expect(join(text("/api/a/x"), text("/api/b/x"))).toEqual(
      string([textPiece(["/api/a/x", "/api/b/x"])]),
    );
    expect(
      join(
        string([textPiece(["/a/"]), holePiece("id"), textPiece(["/x"])]),
        string([textPiece(["/a/"]), holePiece("id"), textPiece(["/y"])]),
      ),
    ).toEqual(
      string([textPiece(["/a/"]), holePiece("id"), textPiece(["/x", "/y"])]),
    );
  });

  it("makes a hole optional when only one side has it", () => {
    expect(
      join(
        string([textPiece(["/a/"]), holePiece("id")]),
        string([textPiece(["/a/"])]),
      ),
    ).toEqual(string([textPiece(["/a/"]), holePiece("id", "optional")]));
  });

  it("makes a literal optional when only one side has it", () => {
    expect(
      join(
        string([holePiece("base"), textPiece(["/x"])]),
        string([holePiece("base")]),
      ),
    ).toEqual(string([holePiece("base"), textPiece(["", "/x"])]));
  });

  it("joins the ranges of two holes in the same place", () => {
    expect(
      join(
        string([textPiece(["/"]), holePiece("a", "one")]),
        string([textPiece(["/"]), holePiece("b", "many")]),
      ),
    ).toEqual(string([textPiece(["/"]), holePiece("a", "many")]));
  });

  it("gives up on a middle that differs by more than one piece", () => {
    expect(
      join(
        string([holePiece("base"), holePiece("a"), textPiece(["/x"])]),
        string([holePiece("base"), textPiece(["b"]), holePiece("c")]),
      ),
    ).toEqual(string([holePiece("base"), holePiece("value", "any")]));
  });

  it("unions constants up to a cap", () => {
    expect(join(constant(1), constant(2))).toEqual({
      kind: "constant",
      options: [1, 2],
    });
    const many = joinAll(Array.from({ length: 9 }, (_, i) => constant(i)));
    expect(many).toEqual(hole("value"));
  });

  it("lines sequences up by position and marks extras optional", () => {
    expect(
      join(sequence([text("a"), text("b")]), sequence([text("a")])),
    ).toEqual({
      kind: "sequence",
      items: [{ value: text("a"), presence: "one" }, optional(text("b"))],
    });
  });

  it("joins a sequence with an unbounded one into an unbounded one", () => {
    expect(join(sequence([text("a")]), unbounded(text("b")))).toEqual(
      unbounded(string([textPiece(["a", "b"])])),
    );
  });

  it("unions record fields and marks the ones only one side has optional", () => {
    const joined = join(
      record([
        ["a", text("1")],
        ["b", text("2")],
      ]),
      record([["a", text("1")]], true),
    );
    expect(joined).toEqual({
      kind: "record",
      fields: new Map([
        ["a", { value: text("1"), presence: "one" }],
        ["b", optional(text("2"))],
      ]),
      open: true,
    });
  });

  it("lets a hole win and gives a hole for different kinds", () => {
    expect(join(hole("x"), text("a"))).toEqual(hole("x"));
    expect(join(text("a"), hole("x"))).toEqual(hole("x"));
    expect(join(text("a"), constant(1))).toEqual(hole("value"));
    expect(joinAll([])).toEqual(hole("value"));
  });
});

describe("joinRange", () => {
  it("takes the wider range, and any for many with optional", () => {
    expect(joinRange("one", "optional")).toBe("optional");
    expect(joinRange("many", "one")).toBe("many");
    expect(joinRange("many", "optional")).toBe("any");
    expect(joinRange("any", "one")).toBe("any");
    expect(joinRange("one", "one")).toBe("one");
  });
});

describe("widen", () => {
  it("keeps what the loop did not change", () => {
    expect(widen(text("a"), text("a"))).toEqual(text("a"));
  });

  it("turns a grown sequence into an unbounded one", () => {
    expect(
      widen(sequence([text("a")]), sequence([text("a"), text("b")])),
    ).toEqual(unbounded(string([textPiece(["a", "b"])])));
  });

  it("opens a record the loop wrote to", () => {
    const widened = widen(
      record([["a", text("1")]]),
      record([
        ["a", text("1")],
        ["b", text("2")],
      ]),
    );
    expect(widened.kind === "record" && widened.open).toBe(true);
  });

  it("keeps the characters a string keeps across iterations", () => {
    expect(widen(text("/a"), text("/a/b"))).toEqual(
      string([textPiece(["/a"]), holePiece("value", "any")]),
    );
    expect(
      widen(
        string([textPiece(["/"]), holePiece("id")]),
        string([textPiece(["/"]), holePiece("id"), textPiece(["/x"])]),
      ),
    ).toEqual(
      string([textPiece(["/"]), holePiece("id"), holePiece("value", "any")]),
    );
  });

  it("gives a hole for values of different kinds", () => {
    expect(widen(text("a"), constant(1))).toEqual(hole("value"));
  });
});

describe("sameValue", () => {
  it("compares structurally", () => {
    expect(sameValue(text("a"), text("a"))).toBe(true);
    expect(sameValue(text("a"), text("b"))).toBe(false);
    expect(sameValue(sequence([text("a")]), sequence([text("a")]))).toBe(true);
    expect(sameValue(sequence([text("a")]), sequence([]))).toBe(false);
    expect(
      sameValue(record([["a", text("1")]]), record([["a", text("1")]])),
    ).toBe(true);
    expect(
      sameValue(record([["a", text("1")]]), record([["b", text("1")]])),
    ).toBe(false);
    expect(sameValue(unbounded(text("a")), unbounded(text("a")))).toBe(true);
    expect(sameValue(hole("a"), hole("a"))).toBe(true);
    expect(sameValue(hole("a"), hole("b"))).toBe(false);
    expect(sameValue({ kind: "ref", id: 1 }, { kind: "ref", id: 1 })).toBe(
      true,
    );
    expect(sameValue(constant(1), constant(2))).toBe(false);
  });
});
