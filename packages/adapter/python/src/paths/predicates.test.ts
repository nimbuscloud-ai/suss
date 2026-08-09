import { describe, expect, it } from "vitest";

import { parsePython } from "../parser.js";
import { predicateOf } from "./predicates.js";

import type { PyNode } from "../parser.js";

/** The condition of `if <source>:`, which is what a branch is gated on. */
async function conditionOf(source: string): Promise<PyNode> {
  const tree = await parsePython(`if ${source}:\n    pass\n`);
  const statement = tree.rootNode.namedChildren[0] as PyNode;
  return statement.childForFieldName("condition") as PyNode;
}

const read = async (source: string) => predicateOf(await conditionOf(source));

describe("what a condition says", () => {
  it("reads `is None` as a null check", async () => {
    expect(await read("order is None")).toEqual({
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "order" },
      negated: false,
    });
  });

  it("reads `is not None` as a negated null check", async () => {
    expect(await read("order is not None")).toEqual({
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "order" },
      negated: true,
    });
  });

  it("reads a null check written the other way round", async () => {
    expect(await read("None is order")).toEqual({
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "order" },
      negated: false,
    });
  });

  it("reads a comparison against a literal, which is what a status test looks like", async () => {
    expect(await read("response.status_code == 404")).toEqual({
      type: "comparison",
      left: { type: "unresolved", sourceText: "response.status_code" },
      op: "eq",
      right: { type: "literal", value: 404 },
    });
  });

  it("reads each operator the IR models", async () => {
    const cases: [string, string][] = [
      ["a == b", "eq"],
      ["a != b", "neq"],
      ["a > b", "gt"],
      ["a >= b", "gte"],
      ["a < b", "lt"],
      ["a <= b", "lte"],
    ];
    for (const [source, op] of cases) {
      const predicate = await read(source);
      expect(predicate.type === "comparison" && predicate.op, source).toBe(op);
    }
  });

  it("reads a bare name as a truthiness check", async () => {
    expect(await read("missing")).toEqual({
      type: "truthinessCheck",
      subject: { type: "unresolved", sourceText: "missing" },
      negated: false,
    });
  });

  it("reads `not` as a negation of what it applies to", async () => {
    expect(await read("not found")).toEqual({
      type: "negation",
      operand: {
        type: "truthinessCheck",
        subject: { type: "unresolved", sourceText: "found" },
        negated: false,
      },
    });
  });

  it("reads through parentheses", async () => {
    expect(await read("(order is None)")).toEqual(await read("order is None"));
  });

  it("keeps a string and a boolean literal as literals", async () => {
    expect(await read("role == 'admin'")).toMatchObject({
      right: { type: "literal", value: "admin" },
    });
    expect(await read("flag == True")).toMatchObject({
      right: { type: "literal", value: true },
    });
  });

  it("leaves anything it does not model opaque, with its own text", async () => {
    const predicate = await read("a in b");
    expect(predicate).toEqual({
      type: "opaque",
      sourceText: "a in b",
      reason: "complexExpression",
    });
  });

  it("leaves a call opaque rather than guessing what it returns", async () => {
    expect((await read("is_ready()")).type).toBe("opaque");
  });
});
