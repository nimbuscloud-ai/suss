import { describe, expect, it } from "vitest";

import { parseRuby } from "../parser.js";
import { isBareMethodCall } from "./bareCalls.js";

import type { RbNode } from "../parser.js";

/** Every identifier in the source, in document order. */
async function identifiersIn(source: string): Promise<RbNode[]> {
  const tree = await parseRuby(source);
  const found: RbNode[] = [];
  const visit = (node: RbNode): void => {
    if (node.type === "identifier") {
      found.push(node);
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(tree.rootNode);
  return found;
}

/**
 * With no locals declared, the only thing keeping a name from reading as a
 * call is the position it is written in.
 */
describe("an identifier in name position, with no locals declared", () => {
  it("is not a call on the left of an assignment", async () => {
    const [left, right] = await identifiersIn("total = subtotal");
    expect(isBareMethodCall(left as RbNode, new Set())).toBe(false);
    expect(isBareMethodCall(right as RbNode, new Set())).toBe(true);
  });

  it("is not a call on the left of an operator assignment", async () => {
    const [left, right] = await identifiersIn("total += subtotal");
    expect(isBareMethodCall(left as RbNode, new Set())).toBe(false);
    expect(isBareMethodCall(right as RbNode, new Set())).toBe(true);
  });

  it("is not a call as the name a def gives", async () => {
    const [name] = await identifiersIn("def helper; end");
    expect(isBareMethodCall(name as RbNode, new Set())).toBe(false);
  });

  it("is not a call as the name a parameter with a default gives", async () => {
    const [, page, limit] = await identifiersIn("def index(page = limit); end");
    expect(isBareMethodCall(page as RbNode, new Set())).toBe(false);
    expect(isBareMethodCall(limit as RbNode, new Set())).toBe(true);
  });
});
