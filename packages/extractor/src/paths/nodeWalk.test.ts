import { describe, expect, it } from "vitest";

import { SKIP_CHILDREN, walkDescendants } from "./nodeWalk.js";

interface Node {
  readonly type: string;
  readonly namedChildren: ReadonlyArray<Node | null>;
}

function node(type: string, ...namedChildren: Array<Node | null>): Node {
  return { type, namedChildren };
}

/** Every node reached, named by type, with the depth the walk carried into it. */
function reached(
  root: Node,
  keepsItsOwnBody: (node: Node) => boolean = () => false,
): string[] {
  const seen: string[] = [];
  walkDescendants<Node, number>(root, 0, {
    at: (child, depth) => seen.push(`${child.type}@${depth}`),
    into: (child, depth) =>
      keepsItsOwnBody(child) ? SKIP_CHILDREN : depth + 1,
  });
  return seen;
}

describe("walkDescendants", () => {
  it("reaches every named node depth first, in source order", () => {
    const tree = node(
      "body",
      node("if", node("call")),
      node("block", node("call")),
    );

    expect(reached(tree)).toEqual(["if@0", "call@1", "block@0", "call@1"]);
  });

  it("skips a node's children without skipping the node", () => {
    const tree = node("body", node("method", node("call")), node("call"));

    expect(reached(tree, (child) => child.type === "method")).toEqual([
      "method@0",
      "call@0",
    ]);
  });

  it("passes over an absent child rather than stopping", () => {
    const tree = node("body", null, node("call"));

    expect(reached(tree)).toEqual(["call@0"]);
  });

  it("does not visit the node it was started from", () => {
    expect(reached(node("body"))).toEqual([]);
  });
});
