import { describe, expect, it } from "vitest";

import { singleAnswers } from "./singleAnswer.js";

describe("the single-answer policy over a [key, answer] relation", () => {
  it("settles a key with exactly one answer", () => {
    const settled = singleAnswers([["a", "b"]]);
    expect(settled.get("a")).toBe("b");
  });

  it("drops a key's match against itself before counting", () => {
    const settled = singleAnswers([
      ["a", "a"],
      ["a", "b"],
    ]);
    expect(settled.get("a")).toBe("b");
  });

  it("leaves out a key whose only answer is itself", () => {
    const settled = singleAnswers([["a", "a"]]);
    expect(settled.has("a")).toBe(false);
  });

  it("leaves out a key with two distinct answers", () => {
    const settled = singleAnswers([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(settled.has("a")).toBe(false);
  });

  it("leaves out a key with no answers", () => {
    const settled = singleAnswers([]);
    expect(settled.size).toBe(0);
  });
});
