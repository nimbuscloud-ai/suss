import { describe, expect, it } from "vitest";

import { NodeMap, NodeSet, nodeKey } from "./ast.js";
import { parsePython } from "./parser.js";

import type { PyNode } from "./parser.js";

/** Two reads of the same child, which tree-sitter returns as two wrappers. */
async function twoReadsOfOneNode(): Promise<[PyNode, PyNode]> {
  const tree = await parsePython("x = 1\n");
  const first = tree.rootNode.namedChildren[0] as PyNode;
  const second = tree.rootNode.namedChildren[0] as PyNode;
  return [first, second];
}

describe("node identity", () => {
  it("hands back a different object for the same node, which is the whole problem", async () => {
    const [first, second] = await twoReadsOfOneNode();
    expect(first === second).toBe(false);
    expect(nodeKey(first)).toBe(nodeKey(second));
    expect(new Set([first]).has(second)).toBe(false);
  });

  it("NodeSet matches a node read a second time", async () => {
    const [first, second] = await twoReadsOfOneNode();
    const set = new NodeSet([first]);
    expect(set.has(second)).toBe(true);
    expect(set.get(second)).toBe(first);
    expect(set.size).toBe(1);
    expect([...set]).toEqual([first]);
  });

  it("NodeSet counts one node once however many times it was read", async () => {
    const [first, second] = await twoReadsOfOneNode();
    const set = new NodeSet([first, second]);
    expect(set.size).toBe(1);
  });

  it("NodeMap reads back a value keyed by a different wrapper", async () => {
    const [first, second] = await twoReadsOfOneNode();
    const map = new NodeMap<string>();
    map.set(first, "value");
    expect(map.get(second)).toBe("value");
    expect(map.has(second)).toBe(true);
    expect(map.size).toBe(1);
    expect([...map]).toEqual([[first, "value"]]);
  });

  it("NodeMap keeps one entry per node rather than one per read", async () => {
    const [first, second] = await twoReadsOfOneNode();
    const map = new NodeMap<string>().set(first, "first").set(second, "second");
    expect(map.size).toBe(1);
    expect(map.get(first)).toBe("second");
  });
});
