import { describe, expect, it } from "vitest";

import { bodyShapesMatch } from "./bodyMatch.js";

import type { TypeShape } from "@suss/behavioral-ir";

const text: TypeShape = { type: "text" };
const integer: TypeShape = { type: "integer" };
const number: TypeShape = { type: "number" };
const boolean: TypeShape = { type: "boolean" };
const nullShape: TypeShape = { type: "null" };
const undef: TypeShape = { type: "undefined" };
const unknown: TypeShape = { type: "unknown" };

function lit(value: string | number | boolean): TypeShape {
  return { type: "literal", value };
}
function record(
  properties: Record<string, TypeShape>,
  spreads?: Array<{ sourceText: string }>,
): TypeShape {
  return spreads
    ? { type: "record", properties, spreads }
    : { type: "record", properties };
}
function union(...variants: TypeShape[]): TypeShape {
  return { type: "union", variants };
}
function array(items: TypeShape): TypeShape {
  return { type: "array", items };
}
function dict(values: TypeShape): TypeShape {
  return { type: "dictionary", values };
}
function ref(name: string): TypeShape {
  return { type: "ref", name };
}

describe("bodyShapesMatch — primitives", () => {
  it("matches identical primitive types", () => {
    expect(bodyShapesMatch(text, text)).toBe("match");
    expect(bodyShapesMatch(integer, integer)).toBe("match");
    expect(bodyShapesMatch(number, number)).toBe("match");
    expect(bodyShapesMatch(boolean, boolean)).toBe("match");
    expect(bodyShapesMatch(nullShape, nullShape)).toBe("match");
    expect(bodyShapesMatch(undef, undef)).toBe("match");
  });

  it("rejects mismatched primitives", () => {
    expect(bodyShapesMatch(text, number)).toBe("nomatch");
    expect(bodyShapesMatch(boolean, text)).toBe("nomatch");
    expect(bodyShapesMatch(nullShape, undef)).toBe("nomatch");
  });

  it("treats integer as a subtype of number", () => {
    expect(bodyShapesMatch(integer, number)).toBe("match");
  });

  it("does not treat number as a subtype of integer", () => {
    expect(bodyShapesMatch(number, integer)).toBe("nomatch");
  });
});

describe("bodyShapesMatch — literal widening", () => {
  it("widens string literal to text", () => {
    expect(bodyShapesMatch(lit("ok"), text)).toBe("match");
  });

  it("does not widen text down to a literal", () => {
    expect(bodyShapesMatch(text, lit("ok"))).toBe("nomatch");
  });

  it("matches identical literals", () => {
    expect(bodyShapesMatch(lit("a"), lit("a"))).toBe("match");
    expect(bodyShapesMatch(lit(42), lit(42))).toBe("match");
    expect(bodyShapesMatch(lit(true), lit(true))).toBe("match");
  });

  it("rejects different literal values", () => {
    expect(bodyShapesMatch(lit("a"), lit("b"))).toBe("nomatch");
    expect(bodyShapesMatch(lit(1), lit(2))).toBe("nomatch");
    expect(bodyShapesMatch(lit(true), lit(false))).toBe("nomatch");
  });

  it("widens number literal to number and integer (when integral)", () => {
    expect(bodyShapesMatch(lit(42), number)).toBe("match");
    expect(bodyShapesMatch(lit(42), integer)).toBe("match");
  });

  it("does not widen non-integer literal to integer", () => {
    expect(bodyShapesMatch(lit(3.14), integer)).toBe("nomatch");
    expect(bodyShapesMatch(lit(3.14), number)).toBe("match");
  });

  it("widens boolean literal to boolean", () => {
    expect(bodyShapesMatch(lit(true), boolean)).toBe("match");
    expect(bodyShapesMatch(lit(false), boolean)).toBe("match");
  });

  it("rejects literal vs unrelated primitive", () => {
    expect(bodyShapesMatch(lit("ok"), number)).toBe("nomatch");
    expect(bodyShapesMatch(lit(42), text)).toBe("nomatch");
    expect(bodyShapesMatch(lit(true), text)).toBe("nomatch");
  });
});

describe("bodyShapesMatch — records", () => {
  it("matches records with identical properties", () => {
    const r = record({ id: text, count: number });
    expect(bodyShapesMatch(r, r)).toBe("match");
  });

  it("allows actual to carry extra fields beyond declared", () => {
    const actual = record({ id: text, count: number, extra: boolean });
    const declared = record({ id: text, count: number });
    expect(bodyShapesMatch(actual, declared)).toBe("match");
  });

  it("rejects when actual is missing a declared field", () => {
    const actual = record({ id: text });
    const declared = record({ id: text, count: number });
    expect(bodyShapesMatch(actual, declared)).toBe("nomatch");
  });

  it("treats missing field as ok when declared allows undefined", () => {
    const actual = record({ id: text });
    const declared = record({ id: text, note: union(text, undef) });
    expect(bodyShapesMatch(actual, declared)).toBe("match");
  });

  it("recurses into nested field shapes", () => {
    const actual = record({ user: record({ id: text, admin: lit(true) }) });
    const declared = record({ user: record({ id: text, admin: boolean }) });
    expect(bodyShapesMatch(actual, declared)).toBe("match");
  });

  it("reports nomatch on deep field-type mismatch", () => {
    const actual = record({ user: record({ id: number }) });
    const declared = record({ user: record({ id: text }) });
    expect(bodyShapesMatch(actual, declared)).toBe("nomatch");
  });

  it("returns unknown when actual has spreads", () => {
    const actual = record({ admin: lit(true) }, [{ sourceText: "user" }]);
    const declared = record({ id: text, admin: boolean });
    expect(bodyShapesMatch(actual, declared)).toBe("unknown");
  });

  it("returns unknown when declared has spreads", () => {
    const actual = record({ id: text, admin: lit(true) });
    const declared = record({ admin: boolean }, [{ sourceText: "base" }]);
    expect(bodyShapesMatch(actual, declared)).toBe("unknown");
  });

  it("rejects non-record actual against record declared", () => {
    expect(bodyShapesMatch(text, record({ id: text }))).toBe("nomatch");
  });
});

describe("bodyShapesMatch — arrays", () => {
  it("matches arrays of the same item type", () => {
    expect(bodyShapesMatch(array(text), array(text))).toBe("match");
  });

  it("widens literal array items", () => {
    expect(bodyShapesMatch(array(lit("ok")), array(text))).toBe("match");
  });

  it("rejects arrays with incompatible items", () => {
    expect(bodyShapesMatch(array(number), array(text))).toBe("nomatch");
  });

  it("rejects non-array actual", () => {
    expect(bodyShapesMatch(text, array(text))).toBe("nomatch");
  });
});

describe("bodyShapesMatch — unions", () => {
  it("matches actual against one variant of declared union", () => {
    expect(bodyShapesMatch(text, union(text, number))).toBe("match");
    expect(bodyShapesMatch(lit("x"), union(text, number))).toBe("match");
  });

  it("rejects actual against declared union with no compatible variant", () => {
    expect(bodyShapesMatch(boolean, union(text, number))).toBe("nomatch");
  });

  it("requires every actual variant to match declared", () => {
    expect(bodyShapesMatch(union(text, lit("x")), text)).toBe("match");
    expect(bodyShapesMatch(union(text, number), text)).toBe("nomatch");
  });

  it("handles union vs union", () => {
    const actual = union(text, number);
    const declared = union(text, number, boolean);
    expect(bodyShapesMatch(actual, declared)).toBe("match");
  });

  it("propagates unknown when a variant pair is unresolvable", () => {
    const actual = union(text, ref("Foo"));
    expect(bodyShapesMatch(actual, text)).toBe("unknown");
  });

  it("declared-union returns unknown when only uncertain variants remain", () => {
    expect(bodyShapesMatch(ref("Bar"), union(text, number))).toBe("unknown");
  });
});

describe("bodyShapesMatch — dictionary", () => {
  it("matches dictionaries with compatible value types", () => {
    expect(bodyShapesMatch(dict(number), dict(number))).toBe("match");
    expect(bodyShapesMatch(dict(lit(1)), dict(number))).toBe("match");
  });

  it("rejects dictionaries with incompatible values", () => {
    expect(bodyShapesMatch(dict(text), dict(number))).toBe("nomatch");
  });

  it("accepts record whose fields all conform to dictionary value type", () => {
    const actual = record({ a: number, b: lit(3) });
    expect(bodyShapesMatch(actual, dict(number))).toBe("match");
  });

  it("rejects record with a field that violates dictionary value type", () => {
    const actual = record({ a: number, b: text });
    expect(bodyShapesMatch(actual, dict(number))).toBe("nomatch");
  });

  it("returns unknown for record with spreads matched against dictionary", () => {
    const actual = record({ a: number }, [{ sourceText: "rest" }]);
    expect(bodyShapesMatch(actual, dict(number))).toBe("unknown");
  });

  it("returns unknown when actual is dictionary and declared is record", () => {
    expect(bodyShapesMatch(dict(text), record({ id: text }))).toBe("unknown");
  });
});

describe("bodyShapesMatch — refs and unknown", () => {
  it("matches refs with the same name", () => {
    expect(bodyShapesMatch(ref("User"), ref("User"))).toBe("match");
  });

  it("returns unknown for refs with different names", () => {
    expect(bodyShapesMatch(ref("User"), ref("Admin"))).toBe("unknown");
  });

  it("returns unknown when one side is a ref and the other is a primitive", () => {
    expect(bodyShapesMatch(ref("User"), text)).toBe("unknown");
    expect(bodyShapesMatch(text, ref("User"))).toBe("unknown");
  });

  it("returns unknown when either side is unknown", () => {
    expect(bodyShapesMatch(unknown, text)).toBe("unknown");
    expect(bodyShapesMatch(text, unknown)).toBe("unknown");
    expect(bodyShapesMatch(unknown, unknown)).toBe("unknown");
  });
});

describe("bodyShapesMatch — short-circuit priority", () => {
  it("nomatch beats unknown when both are present in combined results", () => {
    const actual = record({ id: number, extra: ref("Foo") });
    const declared = record({ id: text });
    expect(bodyShapesMatch(actual, declared)).toBe("nomatch");
  });

  it("unknown wins when no direct nomatch present", () => {
    const actual = record({ id: ref("X") });
    const declared = record({ id: text });
    expect(bodyShapesMatch(actual, declared)).toBe("unknown");
  });
});
