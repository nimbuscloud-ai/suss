import { describe, expect, it } from "vitest";

import { nodeOfKey } from "./nodeKey.js";

import type { SpannedNode } from "./nodeKey.js";

/** A tree over byte spans, nested the way a parse tree is. */
class FakeNode implements SpannedNode<FakeNode> {
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;

  constructor(
    readonly startIndex: number,
    readonly endIndex: number,
    children: FakeNode[] = [],
  ) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  /** The deepest node at the start byte, which a search that ignores the end byte returns. */
  descendantForIndex(start: number, end: number): FakeNode | null {
    const inside = this.children.find(
      (child) => child.startIndex <= start && start < child.endIndex,
    );
    return inside === undefined ? this : inside.descendantForIndex(start, end);
  }
}

const leaf = new FakeNode(4, 8);
const call = new FakeNode(0, 8, [new FakeNode(0, 3), leaf]);
const root = new FakeNode(0, 20, [call, new FakeNode(10, 20)]);
const roots = new Map([["a.rb", root]]);

describe("nodeOfKey", () => {
  it("finds the node whose span the key states", () => {
    expect(nodeOfKey(roots, "a.rb:4-8")).toBe(leaf);
    expect(nodeOfKey(roots, "a.rb:0-8")).toBe(call);
    expect(nodeOfKey(roots, "a.rb:0-20")).toBe(root);
  });

  it("returns null for a name key, an unknown file or a span no node has", () => {
    expect(nodeOfKey(roots, "a.rb#name")).toBeNull();
    expect(nodeOfKey(roots, "b.rb:4-8")).toBeNull();
    expect(nodeOfKey(roots, "a.rb:5-8")).toBeNull();
    expect(nodeOfKey(roots, "a.rb:0-5")).toBeNull();
    expect(nodeOfKey(roots, "a.rb:8-8")).toBeNull();
    expect(nodeOfKey(roots, "a.rb:10-25")).toBeNull();
  });
});
