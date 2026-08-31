import { describe, expect, it } from "vitest";

import { guardsHoldOn, runsBefore } from "./effectGuards.js";

import type { RawCondition } from "./index.js";

function condition(
  sourceText: string,
  polarity: RawCondition["polarity"],
): RawCondition {
  return { sourceText, structured: null, polarity, source: "explicit" };
}

describe("guardsHoldOn", () => {
  it("lets an effect nobody gated onto every branch", () => {
    expect(guardsHoldOn(undefined, [condition("flag", "positive")])).toBe(true);
    expect(guardsHoldOn([], [condition("flag", "positive")])).toBe(true);
  });

  it("lets a guarded effect onto the branch that agrees with it", () => {
    expect(
      guardsHoldOn(
        [condition("flag", "positive")],
        [condition("flag", "positive")],
      ),
    ).toBe(true);
  });

  it("keeps a guarded effect off the branch that recorded the other way", () => {
    expect(
      guardsHoldOn(
        [condition("flag", "positive")],
        [condition("flag", "negative")],
      ),
    ).toBe(false);
  });

  it("keeps a guarded effect where the branch says nothing about the guard", () => {
    expect(
      guardsHoldOn(
        [condition("item.ok", "positive")],
        [condition("items.length > 0", "positive")],
      ),
    ).toBe(true);
  });

  it("needs every guard to survive, not just one", () => {
    expect(
      guardsHoldOn(
        [condition("a", "positive"), condition("b", "positive")],
        [condition("a", "positive"), condition("b", "negative")],
      ),
    ).toBe(false);
  });
});

describe("runsBefore", () => {
  it("counts a call written on the terminal's own line", () => {
    expect(runsBefore(12, 12)).toBe(true);
  });

  it("counts a call written inside the terminal's own expression", () => {
    expect(runsBefore(13, 14)).toBe(true);
  });

  it("keeps a call written after the terminal off it", () => {
    expect(runsBefore(15, 14)).toBe(false);
  });
});
