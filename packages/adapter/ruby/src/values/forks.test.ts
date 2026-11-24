import { describe, expect, it } from "vitest";

import { parseRuby } from "../parser.js";
import { forkArmCondition, forkTests } from "./forks.js";

import type { RbNode } from "../parser.js";

/** The first node of a type under the method `run`, and the method. */
async function nodeIn(
  body: string[],
  type: string,
): Promise<{ node: RbNode; root: RbNode }> {
  const tree = await parseRuby(
    ["def run(archived, user, kind)", ...body, "end"].join("\n"),
  );
  const root = tree.rootNode.namedChild(0);
  const found = (node: RbNode): RbNode | null =>
    node.type === type
      ? node
      : (node.namedChildren.map(found).find((one) => one !== null) ?? null);
  const node = root === null ? null : found(root);
  if (root === null || node === null) {
    throw new Error(`no ${type} in the source`);
  }
  return { node, root };
}

describe("what a Ruby fork tests", () => {
  it("keys a condition by its text, a negation in parentheses folded", async () => {
    const { node, root } = await nodeIn(
      ["  if !(archived)", "    1", "  end"],
      "if",
    );
    expect(forkTests()(node, root)).toEqual({
      key: "archived",
      negated: true,
      reads: ["archived"],
    });
  });

  it("gives a condition that calls a method a key of its own", async () => {
    const { node, root } = await nodeIn(
      ["  x = user.admin? ? 1 : 2"],
      "conditional",
    );
    expect(forkTests()(node, root)?.key).toMatch(/^user\.admin\?@\d+$/);
  });

  it("tests nothing for a node that is no fork", async () => {
    const { node, root } = await nodeIn(["  user.save"], "call");
    expect(forkTests()(node, root)).toBeNull();
    expect(forkArmCondition(node, 0)).toBeNull();
  });

  it("reads a `when` arm's patterns as its condition, and none for the `else`", async () => {
    const { node, root } = await nodeIn(
      ["  case kind", '  when "a" then x = 1', "  else x = 2", "  end"],
      "case",
    );
    expect(forkTests()(node, root)).toEqual({
      key: `case@${node.startIndex}`,
      negated: false,
      reads: ["kind"],
    });
    expect(forkArmCondition(node, 0)?.sourceText).toBe('kind == "a"');
    expect(forkArmCondition(node, 1)).toBeNull();
  });
});
