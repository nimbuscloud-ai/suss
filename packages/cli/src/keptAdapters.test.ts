import { describe, expect, it } from "vitest";

import { KeptAdapters } from "./keptAdapters.js";

describe("KeptAdapters", () => {
  it("hands a read the adapter the last read of its entry left", () => {
    const kept = new KeptAdapters();
    const first = kept.keep("typescript tsconfig.json", "express", () => ({}));
    const second = kept.keep("typescript tsconfig.json", "express", () => ({}));

    expect(second).toBe(first);
    expect(kept.size).toBe(1);
  });

  it("makes a new adapter in the entry's place when the read changed", () => {
    const kept = new KeptAdapters();
    const first = kept.keep("typescript tsconfig.json", "express", () => ({}));
    const second = kept.keep(
      "typescript tsconfig.json",
      "express fastify",
      () => ({}),
    );

    expect(second).not.toBe(first);
    expect(kept.size).toBe(1);
  });

  it("gives a read the files noted before it started, and no later ones", () => {
    const kept = new KeptAdapters();
    kept.noteChanged(["src/a.ts"]);
    kept.startRead();
    kept.noteChanged(["src/b.ts"]);

    expect(kept.changedPaths()).toEqual(["src/a.ts"]);
    kept.startRead();
    expect(kept.changedPaths()).toEqual(["src/b.ts"]);
  });

  it("runs each adapter's own preparation, and nothing once they are let go", async () => {
    const kept = new KeptAdapters();
    const prepared: string[] = [];
    kept.keep(
      "python src",
      "",
      () => "trees",
      async (value) => {
        prepared.push(value);
      },
    );
    await kept.prepare();
    kept.release();
    await kept.prepare();

    expect(prepared).toEqual(["trees"]);
    expect(kept.size).toBe(0);
  });
});
