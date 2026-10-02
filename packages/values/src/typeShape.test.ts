import { describe, expect, it } from "vitest";

import { shapeOfValue } from "./typeShape.js";
import {
  constant,
  deferred,
  hole,
  holePiece,
  record,
  sequence,
  string,
  text,
  textPiece,
  unbounded,
} from "./value.js";

import type { Value } from "./value.js";

describe("shapeOfValue", () => {
  it("writes a record's keys and keeps its literals", () => {
    const body = record([
      ["success", constant(false)],
      ["status", constant(422)],
      ["error", text("not allowed")],
      ["deleted_at", constant(null)],
    ]);
    expect(shapeOfValue(body)).toEqual({
      type: "record",
      properties: {
        success: { type: "literal", value: false },
        status: { type: "literal", value: 422 },
        error: { type: "literal", value: "not allowed" },
        deleted_at: { type: "null" },
      },
    });
  });

  it("leaves a field the evaluator could not read as unknown", () => {
    expect(shapeOfValue(record([["error", hole("message")]]))).toEqual({
      type: "record",
      properties: { error: { type: "unknown" } },
    });
  });

  it("gives an open record a spread, so a key it could not see may be there", () => {
    expect(shapeOfValue(record([["id", constant(1)]], true))).toEqual({
      type: "record",
      properties: { id: { type: "literal", value: 1 } },
      spreads: [{ sourceText: "..." }],
    });
  });

  it("marks a field only one branch wrote as possibly undefined", () => {
    const body: Value = {
      kind: "record",
      fields: new Map([["note", { value: text("x"), presence: "optional" }]]),
      open: false,
    };
    expect(shapeOfValue(body)).toEqual({
      type: "record",
      properties: {
        note: {
          type: "union",
          variants: [{ type: "literal", value: "x" }, { type: "undefined" }],
        },
      },
    });
  });

  it("reads a string with a hole in it as text", () => {
    expect(
      shapeOfValue(string([textPiece(["user-"]), holePiece("id")])),
    ).toEqual({ type: "text" });
  });

  it("reads a string that is one of a few literals as their union", () => {
    expect(shapeOfValue(string([textPiece(["on", "off"])]))).toEqual({
      type: "union",
      variants: [
        { type: "literal", value: "off" },
        { type: "literal", value: "on" },
      ],
    });
  });

  it("reads an array's elements as one item shape", () => {
    expect(shapeOfValue(sequence([constant(1), constant(1)]))).toEqual({
      type: "array",
      items: { type: "literal", value: 1 },
    });
    expect(shapeOfValue(sequence([]))).toEqual({
      type: "array",
      items: { type: "unknown" },
    });
    expect(shapeOfValue(unbounded(text("a")))).toEqual({
      type: "array",
      items: { type: "literal", value: "a" },
    });
  });

  it("reads a constant that is one of several as their union", () => {
    expect(
      shapeOfValue({ kind: "constant", options: [true, undefined] }),
    ).toEqual({
      type: "union",
      variants: [{ type: "literal", value: true }, { type: "undefined" }],
    });
  });

  it("reads through a deferred value and leaves a heap reference unknown", () => {
    expect(shapeOfValue(deferred(() => constant(2)))).toEqual({
      type: "literal",
      value: 2,
    });
    expect(shapeOfValue({ kind: "ref", id: 0 })).toEqual({ type: "unknown" });
  });
});
