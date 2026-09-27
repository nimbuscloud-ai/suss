import { describe, expect, it } from "vitest";

import { KeptParses } from "./keptParses.js";

function counting(): {
  parse: (source: string) => Promise<{ source: string }>;
  count: () => number;
} {
  let calls = 0;
  return {
    parse: async (source) => {
      calls += 1;
      return { source };
    },
    count: () => calls,
  };
}

describe("KeptParses", () => {
  it("hands back last run's tree for a file whose text is the same", async () => {
    const kept = new KeptParses<{ source: string }>();
    const parser = counting();
    const first = await kept.parse("a.py", "x = 1", parser.parse);
    const second = await kept.parse("a.py", "x = 1", parser.parse);

    expect(second).toBe(first);
    expect(parser.count()).toBe(1);
  });

  it("parses a file again when its text changed, and lets go of the old tree", async () => {
    const released: string[] = [];
    const kept = new KeptParses<{ source: string }>((tree) =>
      released.push(tree.source),
    );
    const parser = counting();
    await kept.parse("a.py", "x = 1", parser.parse);
    const changed = await kept.parse("a.py", "x = 2", parser.parse);

    expect(changed.source).toBe("x = 2");
    expect(released).toEqual(["x = 1"]);
  });

  it("keeps two files with the same text apart", async () => {
    const kept = new KeptParses<{ source: string }>();
    const parser = counting();
    const one = await kept.parse("a/__init__.py", "", parser.parse);
    const other = await kept.parse("b/__init__.py", "", parser.parse);

    expect(other).not.toBe(one);
  });

  it("lets go of a file that is not in the run", async () => {
    const released: string[] = [];
    const kept = new KeptParses<{ source: string }>((tree) =>
      released.push(tree.source),
    );
    const parser = counting();
    await kept.parse("a.py", "a", parser.parse);
    await kept.parse("b.py", "b", parser.parse);
    kept.keepOnly(["a.py"]);
    await kept.parse("b.py", "b", parser.parse);

    expect(released).toEqual(["b"]);
    expect(parser.count()).toBe(3);
  });
});
