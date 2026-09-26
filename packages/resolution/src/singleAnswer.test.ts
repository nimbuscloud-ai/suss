import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  answersByKey,
  answersFor,
  placeholderValues,
  singleAnswers,
  withoutOverridden,
} from "./singleAnswer.js";

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

describe("every answer a key has", () => {
  it("lists the answers of a key written two ways", () => {
    const answers = answersByKey([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(answers.get("a")).toEqual(["b", "c"]);
  });

  it("drops a key's match against itself, and the key with it", () => {
    const answers = answersByKey([["a", "a"]]);
    expect(answers.has("a")).toBe(false);
  });

  it("lists a repeated answer once", () => {
    const answers = answersByKey([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(answers.get("a")).toEqual(["b"]);
  });

  it("sets a placeholder answer aside when the key has others", () => {
    const answers = answersByKey(
      [
        ["a", "none"],
        ["a", "b"],
        ["a", "c"],
      ],
      new Set(["none"]),
    );
    expect(answers.get("a")).toEqual(["b", "c"]);
  });
});

describe("the answers of one key, read through the index", () => {
  const filled = (): Database => {
    const db = new Database();
    db.add("written", ["a", "a"]);
    db.add("written", ["a", "none"]);
    db.add("written", ["a", "b"]);
    db.add("written", ["z", "none"]);
    db.add("placeholderValue", ["none"]);
    return db;
  };

  it("applies the same drops as the pass over every row", () => {
    expect(answersFor(filled(), "written", "a")).toEqual(["b"]);
  });

  it("keeps a placeholder that is the key's only answer", () => {
    expect(answersFor(filled(), "written", "z")).toEqual(["none"]);
  });

  it("is empty for a key with no rows, and for a relation with none", () => {
    expect(answersFor(filled(), "written", "q")).toEqual([]);
    expect(answersFor(filled(), "absent", "a")).toEqual([]);
  });

  it("sees a row added after the first read", () => {
    const db = filled();
    expect(answersFor(db, "written", "q")).toEqual([]);
    db.add("written", ["q", "r"]);
    expect(answersFor(db, "written", "q")).toEqual(["r"]);
  });
});

describe("a member a nearer class overrides", () => {
  /** `sub.save`, where Sub overrides the `save` Base declares. */
  const overriddenOnSub = (): Database => {
    const db = new Database();
    db.add("wantedReadsOverridden", ["x", "Sub", "baseSave"]);
    db.add("wantedReadsMemberOn", ["x", "Sub", "baseSave"]);
    return db;
  };

  it("is set aside when every object the read finds it on overrides it", () => {
    expect(
      withoutOverridden(overriddenOnSub(), "x", ["baseSave", "subSave"]),
    ).toEqual(["subSave"]);
  });

  it("stays when the read also finds it on an object that does not override it", () => {
    const db = overriddenOnSub();
    db.add("wantedReadsMemberOn", ["x", "Base", "baseSave"]);
    expect(withoutOverridden(db, "x", ["baseSave", "subSave"])).toEqual([
      "baseSave",
      "subSave",
    ]);
  });

  it("stays when it is the only answer", () => {
    expect(withoutOverridden(overriddenOnSub(), "x", ["baseSave"])).toEqual([
      "baseSave",
    ]);
  });

  it("keeps every answer when setting them aside would leave none", () => {
    const db = overriddenOnSub();
    db.add("wantedReadsOverridden", ["x", "Sub", "subSave"]);
    db.add("wantedReadsMemberOn", ["x", "Sub", "subSave"]);
    expect(withoutOverridden(db, "x", ["baseSave", "subSave"])).toEqual([
      "baseSave",
      "subSave",
    ]);
  });

  it("is set aside by answersFor too", () => {
    const db = overriddenOnSub();
    db.add("wantedIsWrittenAs", ["x", "baseSave"]);
    db.add("wantedIsWrittenAs", ["x", "subSave"]);
    expect(answersFor(db, "wantedIsWrittenAs", "x")).toEqual(["subSave"]);
  });
});
