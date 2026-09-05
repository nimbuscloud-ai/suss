import { describe, expect, it } from "vitest";

import {
  concat,
  constant,
  constantOf,
  deferred,
  force,
  hole,
  holePiece,
  literalOf,
  normalizePieces,
  piecesOf,
  record,
  sequence,
  string,
  text,
  textPiece,
  truthOf,
  unbounded,
} from "./value.js";

describe("normalizePieces", () => {
  it("merges adjacent single literals", () => {
    expect(normalizePieces([textPiece(["/a"]), textPiece(["/b"])])).toEqual([
      textPiece(["/a/b"]),
    ]);
  });

  it("drops an empty literal", () => {
    expect(normalizePieces([textPiece([""]), holePiece("id")])).toEqual([
      holePiece("id"),
    ]);
  });

  it("keeps a set of literals as its own piece", () => {
    expect(
      normalizePieces([
        textPiece(["/a"]),
        textPiece(["x", "y"]),
        textPiece(["/b"]),
      ]),
    ).toEqual([textPiece(["/a"]), textPiece(["x", "y"]), textPiece(["/b"])]);
  });

  it("turns a set wider than the cap into a hole", () => {
    expect(normalizePieces([textPiece(["a", "b", "c", "d", "e"])])).toEqual([
      holePiece("value"),
    ]);
  });

  it("sorts and dedupes a set", () => {
    expect(textPiece(["b", "a", "b"])).toEqual({
      kind: "text",
      options: ["a", "b"],
    });
  });
});

describe("concat and piecesOf", () => {
  it("renders a constant as its text", () => {
    expect(literalOf(concat([text("/v"), constant(2)]))).toBe("/v2");
  });

  it("keeps a hole named after the value", () => {
    expect(piecesOf(hole("id"))).toEqual([holePiece("id")]);
  });

  it("gives an unnamed hole for a sequence or record", () => {
    expect(piecesOf(sequence([text("a")]))).toEqual([holePiece("value")]);
    expect(piecesOf(record([["a", text("a")]]))).toEqual([holePiece("value")]);
    expect(piecesOf(unbounded(text("a")))).toEqual([holePiece("value")]);
  });

  it("renders a set of constants as a set of texts", () => {
    expect(piecesOf({ kind: "constant", options: [1, 2] })).toEqual([
      textPiece(["1", "2"]),
    ]);
  });
});

describe("literalOf", () => {
  it("is the one literal a string is", () => {
    expect(literalOf(text("/a"))).toBe("/a");
    expect(literalOf(string([]))).toBe("");
  });

  it("is null for a set, a hole, or a non-string", () => {
    expect(literalOf(string([textPiece(["a", "b"])]))).toBeNull();
    expect(literalOf(string([holePiece("id")]))).toBeNull();
    expect(literalOf(constant(1))).toBeNull();
  });
});

describe("constantOf and truthOf", () => {
  it("reads a single constant", () => {
    expect(constantOf(constant(true))).toBe(true);
    expect(constantOf({ kind: "constant", options: [1, 2] })).toBeUndefined();
    expect(constantOf(text("a"))).toBeUndefined();
  });

  it("settles a literal condition", () => {
    expect(truthOf(constant(0))).toBe(false);
    expect(truthOf(text(""))).toBe(false);
    expect(truthOf(text("a"))).toBe(true);
    expect(truthOf(hole("flag"))).toBeNull();
    expect(truthOf({ kind: "constant", options: [true, false] })).toBeNull();
  });
});

describe("deferred", () => {
  it("computes once", () => {
    let runs = 0;
    const value = deferred(() => {
      runs++;
      return text("a");
    });
    expect(force(value)).toEqual(text("a"));
    expect(force(value)).toEqual(text("a"));
    expect(runs).toBe(1);
  });

  it("gives a hole when it depends on itself", () => {
    const value: { current: ReturnType<typeof deferred> | null } = {
      current: null,
    };
    value.current = deferred(() => force(value.current ?? hole("x")), "self");
    expect(force(value.current)).toEqual(hole("self"));
  });

  it("forces a deferred result all the way", () => {
    const value = deferred(() => deferred(() => text("a")));
    expect(force(value)).toEqual(text("a"));
  });
});
