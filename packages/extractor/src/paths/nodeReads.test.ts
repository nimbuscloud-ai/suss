import { describe, expect, it } from "vitest";

import { EnclosingNodes } from "./nodeReads.js";

import type { ParsedNode } from "./nodeReads.js";

/**
 * A node that counts how often its parent is read and builds a fresh
 * wrapper for every parent it hands back, the way tree-sitter does.
 */
class FakeNode implements ParsedNode<FakeNode> {
  static parentReads = 0;

  constructor(
    readonly tree: object,
    readonly id: number,
    private readonly parse: FakeParse,
  ) {}

  get type(): string {
    return this.parse.types.get(this.id) ?? "";
  }

  get parent(): FakeNode | null {
    FakeNode.parentReads++;
    const parentId = this.parse.parents.get(this.id);
    return parentId === undefined ? null : this.parse.node(parentId);
  }
}

interface FakeParse {
  types: Map<number, string>;
  parents: Map<number, number>;
  node: (id: number) => FakeNode;
}

/** `module(0) > def(1) > block(2) > call(3), call(4)`. */
function parse(): FakeParse {
  const tree = {};
  const parsed: FakeParse = {
    types: new Map([
      [0, "module"],
      [1, "def"],
      [2, "block"],
      [3, "call"],
      [4, "call"],
    ]),
    parents: new Map([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 2],
    ]),
    node: (id) => new FakeNode(tree, id, parsed),
  };
  return parsed;
}

const definitions = () => new EnclosingNodes<FakeNode>(new Set(["def"]));

describe("the enclosing definition, kept per parse", () => {
  it("finds the nearest enclosing definition", () => {
    const { node } = parse();
    const enclosing = definitions();
    expect(enclosing.of(node(3))?.id).toBe(1);
    expect(enclosing.of(node(1))).toBeNull();
    expect(enclosing.of(node(0))).toBeNull();
  });

  it("answers a node read twice without climbing again, whichever wrapper asks", () => {
    const { node } = parse();
    const enclosing = definitions();
    enclosing.of(node(3));
    FakeNode.parentReads = 0;
    expect(enclosing.of(node(3))?.id).toBe(1);
    expect(enclosing.of(node(2))?.id).toBe(1);
    expect(FakeNode.parentReads).toBe(0);
  });

  it("stops a sibling's climb at the first node already passed", () => {
    const { node } = parse();
    const enclosing = definitions();
    enclosing.of(node(3));
    FakeNode.parentReads = 0;
    expect(enclosing.of(node(4))?.id).toBe(1);
    expect(FakeNode.parentReads).toBe(1);
  });

  it("keeps nothing across parses", () => {
    const enclosing = definitions();
    const earlier = enclosing.of(parse().node(3));
    const later = enclosing.of(parse().node(3));
    expect(later?.id).toBe(1);
    expect(later).not.toBe(earlier);
  });
});
