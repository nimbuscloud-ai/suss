import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FactIndex } from "./factIndex.js";

import type { Tuple } from "./index.js";

const PROPERTY_SEED = Number(process.env.SUSS_FUZZ_SEED) || 20261027;

const added = (index: FactIndex, tuple: Tuple, tag?: unknown): void => {
  index.put(index.key(tuple), tag);
};

describe("FactIndex", () => {
  it("keeps a fact's key when a later tuple shares its first atoms", () => {
    const index = new FactIndex();
    const first = index.key(["a", "b", "c"]);
    index.put(first, "one");
    added(index, ["a", "b", "d"], "two");
    added(index, ["a", "x", "c"], "three");

    expect(index.key(["a", "b", "c"])).toBe(first);
    expect(index.tagOf(index.find(["a", "b", "d"]) ?? first)).toBe("two");
    expect(index.find(["a", "b"])).toBeUndefined();
    expect(index.find(["a", "b", "e"])).toBeUndefined();
    expect(index.size).toBe(3);
  });

  it("tells a tuple apart from a longer one it begins", () => {
    const index = new FactIndex();
    added(index, ["a", "b"], "long");
    added(index, ["a"], "short");

    expect(index.tagOf(index.find(["a"]) as never)).toBe("short");
    expect(index.tagOf(index.find(["a", "b"]) as never)).toBe("long");
  });

  it("keeps 1 and '1' apart", () => {
    const index = new FactIndex();
    added(index, ["a", 1]);

    expect(index.find(["a", "1"])).toBeUndefined();
    expect(index.find(["a", 1])).toBeDefined();
  });

  it("finds what is left after a removed tuple is pruned", () => {
    const index = new FactIndex();
    for (const tuple of [
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "e"],
    ]) {
      added(index, tuple);
    }
    const going = index.find(["a", "b", "c"]);
    index.remove(going as never);
    index.prune(["a", "b", "c"]);

    expect(index.find(["a", "b", "c"])).toBeUndefined();
    expect(index.find(["a", "b", "d"])).toBeDefined();
    expect(index.find(["a", "e"])).toBeDefined();
    expect(index.key(["a", "b", "c"])).not.toBe(going);
  });

  it("prunes nothing for a tuple it never had or still has", () => {
    const index = new FactIndex();
    added(index, ["a", "b"]);
    added(index, ["a", "c"]);
    const kept = index.find(["a", "b"]);
    index.prune(["x", "y"]);
    index.prune(["a", "d"]);
    index.prune(["a", "b"]);

    expect(index.find(["a", "b"])).toBe(kept);
    expect(index.find(["a", "c"])).toBeDefined();
  });

  it("agrees with a set of tuples over any run of adds and removals", () => {
    const atom = fc.constantFrom<string | number>("a", "b", "c", 1, "1");
    const tuple = fc.array(atom, { minLength: 0, maxLength: 3 });
    const step = fc.record({ add: fc.boolean(), tuple });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const index = new FactIndex();
        const model = new Map<string, Tuple>();
        const name = (t: Tuple): string =>
          JSON.stringify(t.map((a) => [typeof a, a]));
        for (const { add, tuple: t } of steps) {
          const key = index.key(t);
          if (add && !index.has(key)) {
            index.put(key, name(t));
            model.set(name(t), t);
          }
          if (!add && index.has(key)) {
            index.remove(key);
            index.prune(t);
            model.delete(name(t));
          }
          expect(index.size).toBe(model.size);
          for (const [named, kept] of model) {
            const found = index.find(kept);
            expect(found === undefined ? undefined : index.tagOf(found)).toBe(
              named,
            );
            expect(index.key(kept)).toBe(found);
          }
        }
        for (const { tuple: t } of steps) {
          expect(index.find(t) !== undefined).toBe(model.has(name(t)));
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 300 },
    );
  });
});
