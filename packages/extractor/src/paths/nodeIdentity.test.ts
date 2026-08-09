import { describe, expect, it } from "vitest";

import { IdMap, IdSet } from "./nodeIdentity.js";

/** Two objects standing for one node, which is what a fresh wrapper per read gives. */
const first = { id: 7, note: "first read" };
const second = { id: 7, note: "second read" };
const other = { id: 8, note: "another node" };

describe("collections keyed by a node id", () => {
  it("matches a node read a second time, where a plain Set does not", () => {
    expect(new Set([first]).has(second)).toBe(false);
    expect(new IdSet([first]).has(second)).toBe(true);
  });

  it("gives back the node it was built with", () => {
    expect(new IdSet([first]).get(second)).toBe(first);
  });

  it("counts one node once however many times it was read", () => {
    expect(new IdSet([first, second]).size).toBe(1);
    expect(new IdSet([first, other]).size).toBe(2);
  });

  it("iterates the nodes it was built with", () => {
    expect([...new IdSet([first, other])]).toEqual([first, other]);
  });

  it("reads a value back through a different wrapper", () => {
    const map = new IdMap<typeof first, string>().set(first, "value");
    expect(map.get(second)).toBe("value");
    expect(map.has(second)).toBe(true);
  });

  it("keeps one entry per node rather than one per read", () => {
    const map = new IdMap<typeof first, string>()
      .set(first, "first")
      .set(second, "second");
    expect(map.size).toBe(1);
    expect(map.get(first)).toBe("second");
  });

  it("iterates its entries", () => {
    const map = new IdMap<typeof first, string>().set(first, "value");
    expect([...map]).toEqual([[first, "value"]]);
  });

  it("says nothing for a node it never saw", () => {
    expect(new IdSet([first]).has(other)).toBe(false);
    expect(new IdMap<typeof first, string>().get(other)).toBeUndefined();
  });
});
