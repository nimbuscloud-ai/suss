import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { placeholderValues, singleAnswers } from "./singleAnswer.js";

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

  it("sets a placeholder answer aside when the key has another", () => {
    const settled = singleAnswers(
      [
        ["a", "none"],
        ["a", "b"],
      ],
      new Set(["none"]),
    );
    expect(settled.get("a")).toBe("b");
  });

  it("keeps a placeholder answer when it is the only one", () => {
    const settled = singleAnswers([["a", "none"]], new Set(["none"]));
    expect(settled.get("a")).toBe("none");
  });

  it("reads the placeholder keys an adapter marked out of the database", () => {
    const db = new Database();
    db.add("placeholderValue", ["f.py:1-5"]);
    db.add("writtenValue", ["f.py:1-5"]);
    db.add("writtenValue", ["f.py:7-12"]);
    expect([...placeholderValues(db)]).toEqual(["f.py:1-5"]);
  });

  it("still leaves out a key with two answers besides the placeholder", () => {
    const settled = singleAnswers(
      [
        ["a", "none"],
        ["a", "b"],
        ["a", "c"],
      ],
      new Set(["none"]),
    );
    expect(settled.has("a")).toBe(false);
  });
});
