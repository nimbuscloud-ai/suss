import { describe, expect, it } from "vitest";

import { bodyShapesMatch, type TypeShape } from "./index.js";

const rec = (props: Record<string, TypeShape>): TypeShape => ({
  type: "record",
  properties: props,
});

describe("bodyShapesMatch — primitives", () => {
  it("matches like primitives and literals assignable to them", () => {
    expect(bodyShapesMatch({ type: "text" }, { type: "text" })).toBe("match");
    expect(
      bodyShapesMatch({ type: "literal", value: "x" }, { type: "text" }),
    ).toBe("match");
    expect(
      bodyShapesMatch({ type: "literal", value: 3 }, { type: "integer" }),
    ).toBe("match");
    expect(bodyShapesMatch({ type: "integer" }, { type: "number" })).toBe(
      "match",
    );
    expect(
      bodyShapesMatch({ type: "literal", value: true }, { type: "boolean" }),
    ).toBe("match");
    expect(bodyShapesMatch({ type: "null" }, { type: "null" })).toBe("match");
    expect(bodyShapesMatch({ type: "undefined" }, { type: "undefined" })).toBe(
      "match",
    );
  });

  it("reports nomatch on incompatible primitives", () => {
    expect(bodyShapesMatch({ type: "text" }, { type: "integer" })).toBe(
      "nomatch",
    );
    expect(
      bodyShapesMatch(
        { type: "literal", value: 1 },
        { type: "literal", value: 2 },
      ),
    ).toBe("nomatch");
  });
});

describe("bodyShapesMatch — records", () => {
  it("matches when every declared property is present and compatible", () => {
    expect(
      bodyShapesMatch(
        rec({ id: { type: "text" }, age: { type: "integer" } }),
        rec({ id: { type: "text" }, age: { type: "integer" } }),
      ),
    ).toBe("match");
  });

  it("reports nomatch when a required declared property is missing", () => {
    expect(
      bodyShapesMatch(
        rec({ id: { type: "text" } }),
        rec({ id: { type: "text" }, name: { type: "text" } }),
      ),
    ).toBe("nomatch");
  });

  it("allows a missing property when the declared type permits undefined", () => {
    expect(
      bodyShapesMatch(
        rec({ id: { type: "text" } }),
        rec({
          id: { type: "text" },
          note: {
            type: "union",
            variants: [{ type: "text" }, { type: "undefined" }],
          },
        }),
      ),
    ).toBe("match");
  });

  it("returns unknown when either side has spreads", () => {
    expect(
      bodyShapesMatch(
        {
          type: "record",
          properties: { id: { type: "text" } },
          spreads: [{ sourceText: "...rest" }],
        },
        rec({ id: { type: "text" } }),
      ),
    ).toBe("unknown");
  });
});

describe("bodyShapesMatch — composites and uncertainty", () => {
  it("matches arrays element-wise", () => {
    expect(
      bodyShapesMatch(
        { type: "array", items: { type: "text" } },
        { type: "array", items: { type: "text" } },
      ),
    ).toBe("match");
  });

  it("matches against a declared union when one variant fits", () => {
    expect(
      bodyShapesMatch(
        { type: "integer" },
        { type: "union", variants: [{ type: "text" }, { type: "number" }] },
      ),
    ).toBe("match");
  });

  it("matches a dictionary by value type", () => {
    expect(
      bodyShapesMatch(
        { type: "dictionary", values: { type: "text" } },
        { type: "dictionary", values: { type: "text" } },
      ),
    ).toBe("match");
  });

  it("is unknown when either side is unknown or an unresolved ref", () => {
    expect(bodyShapesMatch({ type: "unknown" }, { type: "text" })).toBe(
      "unknown",
    );
    expect(
      bodyShapesMatch({ type: "ref", name: "A" }, { type: "ref", name: "B" }),
    ).toBe("unknown");
    expect(
      bodyShapesMatch({ type: "ref", name: "A" }, { type: "ref", name: "A" }),
    ).toBe("unknown");
  });
});

describe("bodyShapesMatch — exhaustive branches", () => {
  const text: TypeShape = { type: "text" };
  const dict = (values: TypeShape): TypeShape => ({
    type: "dictionary",
    values,
  });

  it("dictionary declared: accepts dict, record (combined), rejects others", () => {
    expect(bodyShapesMatch(dict(text), dict(text))).toBe("match");
    expect(bodyShapesMatch(rec({ a: text, b: text }), dict(text))).toBe(
      "match",
    );
    expect(bodyShapesMatch(rec({ a: { type: "integer" } }), dict(text))).toBe(
      "nomatch",
    );
    expect(
      bodyShapesMatch(
        { type: "record", properties: {}, spreads: [{ sourceText: "...r" }] },
        dict(text),
      ),
    ).toBe("unknown");
    expect(bodyShapesMatch(text, dict(text))).toBe("nomatch");
  });

  it("actual dictionary: unknown against a record, nomatch against a primitive", () => {
    expect(bodyShapesMatch(dict(text), rec({ a: text }))).toBe("unknown");
    expect(bodyShapesMatch(dict(text), text)).toBe("nomatch");
  });

  it("record declared but actual is not a record → nomatch", () => {
    expect(bodyShapesMatch(text, rec({ a: text }))).toBe("nomatch");
  });

  it("declared-side spreads make a record comparison unknown", () => {
    expect(
      bodyShapesMatch(rec({ a: text }), {
        type: "record",
        properties: { a: text },
        spreads: [{ sourceText: "...base" }],
      }),
    ).toBe("unknown");
  });

  it("arrays: nomatch when actual is not an array", () => {
    expect(bodyShapesMatch(text, { type: "array", items: text })).toBe(
      "nomatch",
    );
  });

  it("literals: nomatch when actual is not a literal", () => {
    expect(bodyShapesMatch(text, { type: "literal", value: "x" })).toBe(
      "nomatch",
    );
  });

  it("each primitive rejects an incompatible actual", () => {
    expect(bodyShapesMatch({ type: "integer" }, text)).toBe("nomatch");
    expect(bodyShapesMatch(text, { type: "integer" })).toBe("nomatch");
    expect(bodyShapesMatch({ type: "boolean" }, { type: "number" })).toBe(
      "nomatch",
    );
    expect(bodyShapesMatch(text, { type: "boolean" })).toBe("nomatch");
    expect(bodyShapesMatch(text, { type: "null" })).toBe("nomatch");
    expect(bodyShapesMatch(text, { type: "undefined" })).toBe("nomatch");
    expect(
      bodyShapesMatch({ type: "literal", value: 1.5 }, { type: "integer" }),
    ).toBe("nomatch");
  });

  it("declared union: unknown when no variant matches but one is unknown; nomatch when none do", () => {
    expect(
      bodyShapesMatch(text, {
        type: "union",
        variants: [{ type: "integer" }, { type: "unknown" }],
      }),
    ).toBe("unknown");
    expect(
      bodyShapesMatch(text, {
        type: "union",
        variants: [{ type: "integer" }, { type: "boolean" }],
      }),
    ).toBe("nomatch");
  });

  it("actual union: combines variant results (nomatch if any variant fails)", () => {
    expect(
      bodyShapesMatch(
        { type: "union", variants: [text, { type: "integer" }] },
        text,
      ),
    ).toBe("nomatch");
  });

  it("missing property allowed by a bare undefined declared type", () => {
    expect(
      bodyShapesMatch(
        rec({ id: text }),
        rec({ id: text, x: { type: "undefined" } }),
      ),
    ).toBe("match");
  });

  it("accepts a numeric literal against a number, and boolean against boolean", () => {
    expect(
      bodyShapesMatch({ type: "literal", value: 1.5 }, { type: "number" }),
    ).toBe("match");
    expect(bodyShapesMatch({ type: "boolean" }, { type: "boolean" })).toBe(
      "match",
    );
  });

  it("propagates unknown from a property up through the record (combine)", () => {
    expect(
      bodyShapesMatch(
        rec({ a: text, b: { type: "unknown" } }),
        rec({ a: text, b: text }),
      ),
    ).toBe("unknown");
  });
});
