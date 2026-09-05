import { describe, expect, it } from "vitest";

import {
  appended,
  equals,
  extended,
  fallback,
  isPresent,
  joined,
  negated,
  plus,
  isPresent as takesLeftWhenPresent,
} from "./operations.js";
import {
  constant,
  hole,
  holePiece,
  literalOf,
  record,
  sequence,
  string,
  text,
  textPiece,
  unbounded,
} from "./value.js";

describe("appended and extended", () => {
  it("adds to a known sequence", () => {
    expect(appended(sequence([text("a")]), [text("b")])).toEqual(
      sequence([text("a"), text("b")]),
    );
    expect(extended(sequence([text("a")]), sequence([text("b")]))).toEqual(
      sequence([text("a"), text("b")]),
    );
  });

  it("joins into an unbounded sequence", () => {
    expect(appended(unbounded(text("a")), [text("b")])).toEqual(
      unbounded(string([textPiece(["a", "b"])])),
    );
    expect(extended(sequence([text("a")]), unbounded(text("b")))).toEqual(
      unbounded(string([textPiece(["a", "b"])])),
    );
    expect(extended(unbounded(text("a")), hole("x"))).toEqual(
      unbounded(hole("value")),
    );
  });

  it("gives an unbounded sequence of holes for something unknown", () => {
    expect(appended(hole("x"), [text("b")])).toEqual(unbounded(hole("value")));
    expect(extended(hole("x"), hole("y"))).toEqual(unbounded(hole("value")));
  });
});

describe("joined", () => {
  it("joins literals with the separator", () => {
    expect(literalOf(joined(sequence([text("a"), text("b")]), text("/")))).toBe(
      "a/b",
    );
    expect(literalOf(joined(sequence([text("a"), text("b")]), undefined))).toBe(
      "a,b",
    );
  });

  it("renders a constant element as its text", () => {
    expect(
      literalOf(joined(sequence([text("v"), constant(2)]), text(""))),
    ).toBe("v2");
  });

  it("keeps a hole and the pieces of a string element", () => {
    expect(
      joined(
        sequence([
          text("a"),
          hole("id"),
          string([holePiece("x"), textPiece(["y"])]),
        ]),
        text("/"),
      ),
    ).toEqual(
      string([
        textPiece(["a/"]),
        holePiece("id"),
        textPiece(["/"]),
        holePiece("x"),
        textPiece(["y"]),
      ]),
    );
  });

  it("makes an optional element a piece that may be absent", () => {
    expect(
      joined(
        {
          kind: "sequence",
          items: [
            { value: text("a"), presence: "one" },
            { value: text("b"), presence: "optional" },
            { value: hole("id"), presence: "optional" },
          ],
        },
        text("/"),
      ),
    ).toEqual(
      string([
        textPiece(["a"]),
        textPiece(["", "/b"]),
        holePiece("id", "optional"),
      ]),
    );
  });

  it("gives up on an unbounded sequence or an unknown separator", () => {
    expect(joined(unbounded(text("a")), text("/"))).toEqual(
      string([holePiece("value", "any")]),
    );
    expect(joined(sequence([text("a")]), hole("sep"))).toEqual(
      string([holePiece("value", "any")]),
    );
    expect(joined(hole("x"), text("/"))).toEqual(hole("value"));
  });
});

describe("plus", () => {
  it("adds numbers and concatenates otherwise", () => {
    expect(plus(constant(1), constant(2))).toEqual(constant(3));
    expect(literalOf(plus(text("/a"), text("/b")))).toBe("/a/b");
    expect(literalOf(plus(text("/v"), constant(1)))).toBe("/v1");
    expect(plus(constant(true), constant(null))).toEqual(hole("value"));
  });
});

describe("equals and negated", () => {
  it("settles a comparison of two literals or constants", () => {
    expect(equals(text("a"), text("a"))).toEqual(constant(true));
    expect(equals(text("a"), text("b"))).toEqual(constant(false));
    expect(equals(constant(1), constant(1))).toEqual(constant(true));
    expect(equals(text("1"), constant(1))).toEqual(constant(false));
    expect(equals(text("a"), hole("x"))).toEqual(hole("value"));
  });

  it("negates a constant or the emptiness of a literal", () => {
    expect(negated(constant(true))).toEqual(constant(false));
    expect(negated(text(""))).toEqual(constant(true));
    expect(negated(text("a"))).toEqual(constant(false));
    expect(negated(hole("x"))).toEqual(hole("value"));
  });
});

describe("fallback and isPresent", () => {
  it("takes the left side when it is certainly present", () => {
    expect(fallback(text("a"), text("b"), takesLeftWhenPresent)).toEqual(
      text("a"),
    );
  });

  it("takes the right side when the left is certainly absent", () => {
    expect(fallback(constant(null), text("b"), takesLeftWhenPresent)).toEqual(
      text("b"),
    );
  });

  it("joins both when the left is open", () => {
    expect(fallback(hole("x"), text("b"), takesLeftWhenPresent)).toEqual(
      hole("x"),
    );
    expect(
      fallback(
        { kind: "constant", options: [null, 1] },
        constant(2),
        isPresent,
      ),
    ).toEqual({ kind: "constant", options: [null, 1, 2] });
  });

  it("knows a string, sequence or record is present", () => {
    expect(isPresent(text("a"))).toBe(true);
    expect(isPresent(sequence([]))).toBe(true);
    expect(isPresent(record([]))).toBe(true);
    expect(isPresent(unbounded(hole("x")))).toBe(true);
    expect(isPresent(constant(undefined))).toBe(false);
    expect(isPresent(hole("x"))).toBeNull();
  });
});
