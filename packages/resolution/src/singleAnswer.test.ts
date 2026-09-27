import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  answersFor,
  resolvedFunctions,
  settledFunction,
  withoutOverridden,
  writtenAnswersFor,
  writtenAnswersUnder,
} from "./singleAnswer.js";

describe("the answers to a written-as question", () => {
  const filled = (): Database => {
    const db = new Database();
    db.add("written", ["a", "a"]);
    db.add("written", ["a", "none"]);
    db.add("written", ["a", "b"]);
    db.add("written", ["z", "none"]);
    db.add("written", ["two", "b"]);
    db.add("written", ["two", "c"]);
    db.add("written", ["self", "self"]);
    db.add("placeholderValue", ["none"]);
    return db;
  };

  it("sets aside a key's match against itself and a placeholder", () => {
    expect(writtenAnswersFor(filled(), "written", "a")).toEqual(["b"]);
  });

  it("is empty for a key whose only answer is itself", () => {
    expect(writtenAnswersFor(filled(), "written", "self")).toEqual([]);
  });

  it("keeps a placeholder that is the key's only answer", () => {
    expect(writtenAnswersFor(filled(), "written", "z")).toEqual(["none"]);
  });

  it("lists every answer of a key written two ways, in row order", () => {
    expect(writtenAnswersFor(filled(), "written", "two")).toEqual(["b", "c"]);
  });

  it("is empty for a key with no rows, and for a relation with none", () => {
    expect(writtenAnswersFor(filled(), "written", "q")).toEqual([]);
    expect(writtenAnswersFor(filled(), "absent", "a")).toEqual([]);
  });

  it("sees a row added after the first read", () => {
    const db = filled();
    expect(writtenAnswersFor(db, "written", "q")).toEqual([]);
    db.add("written", ["q", "r"]);
    expect(writtenAnswersFor(db, "written", "q")).toEqual(["r"]);
  });
});

describe("the answers under one allocation site", () => {
  it("reads only that site's rows, with the same drops", () => {
    const db = new Database();
    db.add("writtenUnder", ["a", "s1", "a"]);
    db.add("writtenUnder", ["a", "s1", "none"]);
    db.add("writtenUnder", ["a", "s1", "b"]);
    db.add("writtenUnder", ["a", "s2", "c"]);
    db.add("placeholderValue", ["none"]);
    expect(writtenAnswersUnder(db, "writtenUnder", "a", "s1")).toEqual(["b"]);
    expect(writtenAnswersUnder(db, "writtenUnder", "a", "s2")).toEqual(["c"]);
  });
});

describe("the answers to any other question", () => {
  it("keeps a key that is its own answer, since a function comes to itself", () => {
    const db = new Database();
    db.add("wantedComesTo", ["f", "f"]);
    expect(answersFor(db, "wantedComesTo", "f")).toEqual(["f"]);
  });

  it("sets a placeholder aside the same way", () => {
    const db = new Database();
    db.add("wantedComesTo", ["x", "none"]);
    db.add("wantedComesTo", ["x", "obj"]);
    db.add("placeholderValue", ["none"]);
    expect(answersFor(db, "wantedComesTo", "x")).toEqual(["obj"]);
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

  it("is set aside by every reader", () => {
    const db = overriddenOnSub();
    db.add("wantedIsWrittenAs", ["x", "baseSave"]);
    db.add("wantedIsWrittenAs", ["x", "subSave"]);
    db.add("wantedResolves", ["x", "baseSave"]);
    db.add("wantedResolves", ["x", "subSave"]);
    expect(writtenAnswersFor(db, "wantedIsWrittenAs", "x")).toEqual([
      "subSave",
    ]);
    expect(answersFor(db, "wantedResolves", "x")).toEqual(["subSave"]);
    expect(settledFunction(db, "x")).toBe("subSave");
  });
});

describe("the functions calling a value runs", () => {
  it("lists what the value resolves to and what a factory gave back, once each", () => {
    const db = new Database();
    db.add("wantedResolves", ["x", "f"]);
    db.add("wantedGivesBack", ["x", "f"]);
    db.add("wantedGivesBack", ["x", "g"]);
    expect(resolvedFunctions(db, "x")).toEqual(["f", "g"]);
    expect(settledFunction(db, "x")).toBeNull();
  });

  it("settles a value a factory gave back one function for", () => {
    const db = new Database();
    db.add("wantedGivesBack", ["make()", "handler"]);
    expect(settledFunction(db, "make()")).toBe("handler");
  });

  it("sets aside an override found through the other relation", () => {
    const db = new Database();
    db.add("wantedResolves", ["x", "baseSave"]);
    db.add("wantedGivesBack", ["x", "subSave"]);
    db.add("wantedReadsOverridden", ["x", "Sub", "baseSave"]);
    db.add("wantedReadsMemberOn", ["x", "Sub", "baseSave"]);
    expect(resolvedFunctions(db, "x")).toEqual(["subSave"]);
  });
});
