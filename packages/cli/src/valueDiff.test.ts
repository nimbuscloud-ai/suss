import { describe, expect, it } from "vitest";

import { differenceTexts } from "./valueDiff.js";

const tree = (children: unknown[]) => ({
  type: "render",
  component: "section",
  root: { type: "element", tag: "section", children },
});

const expression = (sourceText: string) => ({
  type: "expression",
  sourceText,
});

describe("differenceTexts", () => {
  it("prints a value that is not a structure as it was and as it is", () => {
    expect(differenceTexts("isDefault", true, false)).toEqual([
      "isDefault: true -> false",
    ]);
  });

  it("gives the path down to the one expression that moved", () => {
    expect(
      differenceTexts(
        "output",
        tree([expression("order.total"), expression("order.note")]),
        tree([expression("order.total"), expression("order.deliveryNote")]),
      ),
    ).toEqual([
      'output.root.children[1].sourceText: "order.note" -> "order.deliveryNote"',
    ]);
  });

  it("reads a key that went while another came with the same value as a rename", () => {
    expect(
      differenceTexts(
        "expectedInput",
        { properties: { note: { type: "text" }, id: { type: "text" } } },
        {
          properties: { deliveryNote: { type: "text" }, id: { type: "text" } },
        },
      ),
    ).toEqual(["expectedInput.properties.note renamed to deliveryNote"]);
  });

  it("reports one child put in the middle of a list, and none of the children after it", () => {
    const before = tree([expression("a"), expression("c"), expression("d")]);
    const after = tree([
      expression("a"),
      expression("b"),
      expression("c"),
      expression("d"),
    ]);

    expect(differenceTexts("output", before, after)).toEqual([
      'output.root.children[1]: (none) -> {"type":"expression","sourceText":"b"}',
    ]);
  });

  it("cuts two long strings down to where they differ, and sixteen characters either side", () => {
    const start = "a".repeat(80);
    const end = "z".repeat(80);

    expect(
      differenceTexts("note", `${start}_old_${end}`, `${start}_new_${end}`),
    ).toEqual([
      `note: "...${"a".repeat(15)}_old_${"z".repeat(15)}..." -> "...${"a".repeat(15)}_new_${"z".repeat(15)}..."`,
    ]);
  });

  it("says what a long structure is instead of printing part of it", () => {
    const wide = {
      type: "element",
      tag: "table",
      attrs: { className: "orders-table orders-table--striped" },
      children: [],
      target: { file: "src/table.tsx", name: "OrdersTable" },
    };

    expect(differenceTexts("output", { root: null }, { root: wide })).toEqual([
      "output.root: null -> { type, tag, attrs, children, ... }",
    ]);
  });

  it("leaves the middle out of a long path", () => {
    const nested = (value: string) => ({
      a: { b: { c: { d: { e: value } } } },
    });

    expect(differenceTexts("output", nested("x"), nested("y"))).toEqual([
      'output...c.d.e: "x" -> "y"',
    ]);
  });

  it("lists the first three differences and counts the rest", () => {
    expect(
      differenceTexts(
        "output",
        { a: 1, b: 1, c: 1, d: 1, e: 1 },
        { a: 2, b: 2, c: 2, d: 2, e: 2 },
      ),
    ).toEqual([
      "output.a: 1 -> 2",
      "output.b: 1 -> 2",
      "output.c: 1 -> 2",
      "and 2 more in output",
    ]);
  });

  it("finds nothing when only the order of the keys moved", () => {
    expect(differenceTexts("output", { a: 1, b: 2 }, { b: 2, a: 1 })).toEqual(
      [],
    );
  });
});
