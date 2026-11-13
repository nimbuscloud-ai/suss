import { describe, expect, it } from "vitest";

import { bodyStatements } from "./ast.js";
import { parseRuby } from "./parser.js";
import { writtenShapeOf } from "./writtenShape.js";

import type { RbNode } from "./parser.js";

describe("writtenShapeOf", () => {
  it("keeps a hash field written with no value, whose shape is the name's", async () => {
    const tree = await parseRuby('{ id:, name: "x", count: 1 }\n');
    expect(writtenShapeOf(bodyStatements(tree.rootNode)[0] as RbNode)).toEqual({
      type: "record",
      properties: {
        id: { type: "unknown" },
        name: { type: "literal", value: "x" },
        count: { type: "integer" },
      },
    });
  });
});
