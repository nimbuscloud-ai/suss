// The parameter list the lowering hands the evaluator. What the
// evaluator then does with these names is covered in evaluator.test.ts.
import { describe, expect, it } from "vitest";

import { bodyStatements } from "../ast.js";
import { parseRuby } from "../parser.js";
import { rubyLowering } from "./lowering.js";

import type { Parameter } from "@suss/values";
import type { RbNode } from "../parser.js";

const FUNCTION_TYPES = new Set([
  "method",
  "singleton_method",
  "block",
  "do_block",
]);

/** The first method or block in a tree, for a test that wants the node the lowering sees. */
function findFunctionNode(node: RbNode): RbNode | null {
  if (FUNCTION_TYPES.has(node.type)) {
    return node;
  }
  for (const child of bodyStatements(node)) {
    const found = findFunctionNode(child);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** The parameters of the first method or block declared in `source`. */
async function parametersOf(
  source: string,
): Promise<readonly Parameter<RbNode>[]> {
  const tree = await parseRuby(source);
  const fn = findFunctionNode(tree.rootNode);
  const shape =
    fn === null
      ? null
      : rubyLowering({ context: null, rows: [] }).functionOf(fn);
  return shape?.parameters ?? [];
}

/** Each parameter as its name and the argument position it reads. */
async function shapesOf(source: string) {
  return (await parametersOf(source)).map((parameter) => ({
    name: parameter.name,
    position: parameter.position,
  }));
}

describe("parameter lowering", () => {
  it("keeps the declared position of a plain parameter", async () => {
    expect(await shapesOf("def route(a, b); end\n")).toEqual([
      { name: "a", position: 0 },
      { name: "b", position: 1 },
    ]);
  });

  it("keeps the position a destructured block parameter shifted", async () => {
    expect(await shapesOf("pairs.each { |(a, b), c| c }\n")).toEqual([
      { name: "c", position: 1 },
    ]);
  });
});
