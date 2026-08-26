import { describe, expect, it } from "vitest";

import { omissionNote, SHOWN, trim } from "./budget.js";

describe("trim", () => {
  it("shows the first few and counts the rest by kind", () => {
    const items = [
      ...Array.from({ length: 30 }, () => ({ kind: "a" })),
      ...Array.from({ length: 5 }, () => ({ kind: "b" })),
    ];
    const trimmed = trim(items, (one) => one.kind);

    expect(trimmed.shown).toHaveLength(SHOWN);
    expect(trimmed.omitted).toBe(35 - SHOWN);
    // 30 of one kind is one problem; 30 across twelve is twelve.
    expect(trimmed.byKind).toEqual({ a: 30, b: 5 });
  });

  it("leaves a short list alone", () => {
    const trimmed = trim([{ kind: "a" }], (one) => one.kind);
    expect(trimmed.shown).toHaveLength(1);
    expect(trimmed.omitted).toBe(0);
    expect(omissionNote(trimmed.omitted, "findings", "Narrow it.")).toBe(
      undefined,
    );
  });

  it("says how to see the rest", () => {
    expect(omissionNote(4, "findings", "Ask about one boundary.")).toBe(
      "4 more findings are not shown. Ask about one boundary.",
    );
  });
});
