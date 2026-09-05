import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { writtenValueOf } from "./writtenValue.js";

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
});
