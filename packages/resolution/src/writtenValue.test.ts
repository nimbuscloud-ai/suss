import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { writtenValueOf, writtenValuesOf } from "./writtenValue.js";

describe("the expression a key was written as", () => {
  it("returns the one expression a key is written as", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    const asked: string[][] = [];
    expect(
      writtenValueOf(db, "f.py:1-5", (keys) => asked.push([...keys])),
    ).toBe("f.py:7-12");
    expect(asked).toEqual([]);
  });

  it("returns null for a key the rules never settled", () => {
    const db = new Database();
    expect(writtenValueOf(db, "f.py:1-5", () => {})).toBeNull();
  });

  it("asks about a call and returns what the callee returns", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    db.add("call", ["f.py:7-12", "f.py:20-30"]);
    const asked: string[][] = [];
    const answer = writtenValueOf(db, "f.py:1-5", (keys) => {
      asked.push([...keys]);
      db.add("wantedIsWrittenAs", ["f.py:7-12", "f.py:40-44"]);
    });
    expect(asked).toEqual([["f.py:7-12"]]);
    expect(answer).toBe("f.py:40-44");
  });

  it("keeps the call when asking about it settles nothing", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    db.add("call", ["f.py:7-12", "f.py:20-30"]);
    expect(writtenValueOf(db, "f.py:1-5", () => {})).toBe("f.py:7-12");
  });

  it("gives back nothing for a key written two ways", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:14-19"]);
    expect(writtenValueOf(db, "f.py:1-5", () => {})).toBeNull();
  });
});

describe("every expression a key was written as", () => {
  it("lists both expressions a key written two ways settles on", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:14-19"]);
    expect(writtenValuesOf(db, "f.py:1-5", () => {})).toEqual([
      "f.py:7-12",
      "f.py:14-19",
    ]);
  });

  it("gives back an empty list for a key the rules never settled", () => {
    const db = new Database();
    expect(writtenValuesOf(db, "f.py:1-5", () => {})).toEqual([]);
  });

  it("asks about every answer that is a call and takes what each returns", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:7-12"]);
    db.add("wantedIsWrittenAs", ["f.py:1-5", "f.py:14-19"]);
    db.add("call", ["f.py:7-12", "f.py:20-30"]);
    db.add("call", ["f.py:14-19", "f.py:31-40"]);
    const asked: string[][] = [];
    const answers = writtenValuesOf(db, "f.py:1-5", (keys) => {
      asked.push([...keys]);
      db.add("wantedIsWrittenAs", ["f.py:7-12", "f.py:50-54"]);
    });
    expect(asked).toEqual([["f.py:7-12", "f.py:14-19"]]);
    expect(answers).toEqual(["f.py:50-54", "f.py:14-19"]);
  });

  it("lists what each write put in a name the rules settled on nothing", () => {
    const db = new Database();
    db.add("mayHold", ["f.py#router", "f.py:7-12"]);
    db.add("mayHold", ["f.py#router", "f.py:14-19"]);
    expect(writtenValuesOf(db, "f.py#router", () => {})).toEqual([
      "f.py:7-12",
      "f.py:14-19",
    ]);
  });

  it("keeps what the rules settled over what the writes put there", () => {
    const db = new Database();
    db.add("wantedIsWrittenAs", ["f.py#router", "f.py:7-12"]);
    db.add("mayHold", ["f.py#router", "f.py:14-19"]);
    expect(writtenValuesOf(db, "f.py#router", () => {})).toEqual(["f.py:7-12"]);
  });

  it("lists nothing when one of the writes stated no value at all", () => {
    const db = new Database();
    db.add("mayHold", ["f.py#router", "f.py:7-12"]);
    db.add("mayHold", ["f.py#router", "f.py:14-19"]);
    db.add("writesUnstated", ["f.py#router"]);
    expect(writtenValuesOf(db, "f.py#router", () => {})).toEqual([]);
  });

  it("lists nothing for a lone write the policy already declined", () => {
    const db = new Database();
    db.add("mayHold", ["f.py#router", "f.py:7-12"]);
    expect(writtenValuesOf(db, "f.py#router", () => {})).toEqual([]);
  });

  it("gives back nothing from the one-answer form when the writes disagree", () => {
    const db = new Database();
    db.add("mayHold", ["f.py#router", "f.py:7-12"]);
    db.add("mayHold", ["f.py#router", "f.py:14-19"]);
    expect(writtenValueOf(db, "f.py#router", () => {})).toBeNull();
  });
});
