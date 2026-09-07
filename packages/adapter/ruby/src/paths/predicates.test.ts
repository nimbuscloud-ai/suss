import { describe, expect, it } from "vitest";

import { parseRuby } from "../parser.js";
import { predicateOf } from "./predicates.js";

import type { RbNode } from "../parser.js";

/** The condition of `x = 1 if <source>`, which is what a branch is gated on. */
async function conditionOf(source: string): Promise<RbNode> {
  const tree = await parseRuby(`x = 1 if ${source}\n`);
  const modifier = tree.rootNode.namedChildren[0] as RbNode;
  return modifier.childForFieldName("condition") as RbNode;
}

const read = async (source: string) => predicateOf(await conditionOf(source));

describe("what a Ruby condition says", () => {
  it("reads a comparison against a literal, which is what a status test looks like", async () => {
    expect(await read("response.status == 404")).toEqual({
      type: "comparison",
      left: { type: "dependency", name: "response", accessChain: ["status"] },
      op: "eq",
      right: { type: "literal", value: 404 },
    });
  });

  it("reads through the conversion a string status is put through", async () => {
    expect(await read("response.code.to_i == 404")).toMatchObject({
      left: { type: "dependency", name: "response", accessChain: ["code"] },
    });
  });

  it("reads each operator the IR models", async () => {
    const cases: [string, string][] = [
      ["a.b == 1", "eq"],
      ["a.b != 1", "neq"],
      ["a.b > 1", "gt"],
      ["a.b >= 1", "gte"],
      ["a.b < 1", "lt"],
      ["a.b <= 1", "lte"],
    ];
    for (const [source, op] of cases) {
      const predicate = await read(source);
      expect(predicate.type === "comparison" && predicate.op, source).toBe(op);
    }
  });

  it("reads nil? as a null check on what it was asked of", async () => {
    expect(await read("order.nil?")).toEqual({
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "order" },
      negated: false,
    });
  });

  it("reads a member read as a truthiness check", async () => {
    expect(await read("response.success?")).toMatchObject({
      type: "truthinessCheck",
      subject: {
        type: "dependency",
        name: "response",
        accessChain: ["success?"],
      },
    });
  });

  it("reads ! as a negation of what it applies to", async () => {
    expect(await read("!flag")).toEqual({
      type: "negation",
      operand: {
        type: "truthinessCheck",
        subject: { type: "unresolved", sourceText: "flag" },
        negated: false,
      },
    });
  });

  it("reads && and || as the compound they are", async () => {
    expect(await read("a.b == 1 && c.d == 2")).toMatchObject({
      type: "compound",
      op: "and",
    });
    expect(await read("a.b == 1 || c.d == 2")).toMatchObject({
      type: "compound",
      op: "or",
    });
  });

  it("keeps a string and a boolean literal as literals", async () => {
    expect(await read("role.name == 'admin'")).toMatchObject({
      right: { type: "literal", value: "admin" },
    });
    expect(await read("flag.set == true")).toMatchObject({
      right: { type: "literal", value: true },
    });
  });

  it("leaves a call with arguments unresolved rather than reading it as a member", async () => {
    expect(await read("response.header('x') == 'y'")).toMatchObject({
      left: { type: "unresolved" },
    });
  });

  it("reads through parentheses", async () => {
    expect(await read("(order.nil?)")).toEqual(await read("order.nil?"));
  });

  it("leaves an operator the IR does not model opaque", async () => {
    expect((await read("a.b + c.d")).type).toBe("opaque");
  });

  it("leaves anything it does not model opaque, with its own text", async () => {
    expect(await read("items.include?(order)")).toMatchObject({
      type: "opaque",
      reason: "complexExpression",
    });
  });
});
