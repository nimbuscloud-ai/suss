import { describe, expect, it } from "vitest";

import { parsePython } from "../parser.js";
import { returnedBodyShape, shapeOfReturned } from "./returnedShape.js";

import type { PyNode } from "../parser.js";

/** The return statement of a one-line function body. */
async function returnOf(source: string): Promise<PyNode> {
  const tree = await parsePython(`def f():\n    ${source}\n`);
  const fn = tree.rootNode.namedChildren[0] as PyNode;
  const body = fn.childForFieldName("body") as PyNode;
  return body.namedChildren[0] as PyNode;
}

describe("the shape a return writes", () => {
  it("reads a dict of literals as a record", async () => {
    expect(
      await returnOf('return {"error": "nope"}').then(returnedBodyShape),
    ).toEqual({
      type: "record",
      properties: { error: { type: "literal", value: "nope" } },
    });
  });

  it("takes the body off a returned tuple and leaves the status", async () => {
    expect(
      await returnOf('return {"a": 1}, 201').then(returnedBodyShape),
    ).toEqual({
      type: "record",
      properties: { a: { type: "literal", value: 1 } },
    });
  });

  it("keeps a name as a ref rather than guessing what it refers to", async () => {
    expect(
      await returnOf('return {"id": order_id}').then(returnedBodyShape),
    ).toEqual({
      type: "record",
      properties: { id: { type: "ref", name: "order_id" } },
    });
  });

  it("reads a nested dict as a nested record", async () => {
    expect(
      await returnOf('return {"user": {"name": "ada"}}').then(
        returnedBodyShape,
      ),
    ).toEqual({
      type: "record",
      properties: {
        user: {
          type: "record",
          properties: { name: { type: "literal", value: "ada" } },
        },
      },
    });
  });

  it("reads a list by the shape of its first element", async () => {
    expect(await returnOf('return ["a", "b"]').then(returnedBodyShape)).toEqual(
      {
        type: "array",
        items: { type: "literal", value: "a" },
      },
    );
  });

  it("falls back to a dictionary when a key is not written out", async () => {
    expect(
      await returnOf("return {key: value}").then(returnedBodyShape),
    ).toEqual({
      type: "dictionary",
      values: { type: "unknown" },
    });
  });

  it("claims nothing for a call it has not followed", async () => {
    expect(await returnOf("return build()").then(returnedBodyShape)).toBeNull();
  });

  it("claims nothing for a bare return", async () => {
    expect(await returnOf("return").then(returnedBodyShape)).toBeNull();
  });

  it("reads the scalars a body can be written as", async () => {
    const cases: [string, unknown][] = [
      ["None", { type: "null" }],
      ["True", { type: "boolean" }],
      ["1.5", { type: "number" }],
      ["7", { type: "literal", value: 7 }],
    ];
    for (const [source, expected] of cases) {
      const statement = await returnOf(`return ${source}`);
      const value = statement.namedChildren[0] as PyNode;
      expect(shapeOfReturned(value), source).toEqual(expected);
    }
  });

  it("stops at a depth rather than following a value forever", async () => {
    const nested = '{"a": {"b": {"c": {"d": {"e": {"f": {"g": "deep"}}}}}}}';
    const shape = await returnOf(`return ${nested}`).then(returnedBodyShape);
    expect(JSON.stringify(shape)).toContain("unknown");
  });
  it("falls back to a dictionary for a dict written with a spread", async () => {
    expect(
      await returnOf('return {**defaults, "a": 1}').then(returnedBodyShape),
    ).toEqual({ type: "dictionary", values: { type: "unknown" } });
  });

  it("claims nothing for a returned tuple with nothing in it", async () => {
    const statement = await returnOf("return ()");
    expect(returnedBodyShape(statement)).toEqual({
      type: "array",
      items: { type: "unknown" },
    });
  });
});
