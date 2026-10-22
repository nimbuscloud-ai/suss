import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { readDynamicNames } from "./defineMethod.js";

describe("readDynamicNames", () => {
  it("leaves out loop rows not keyed on a block, and calls a name with no node in the run unreadable", () => {
    const db = new Database();
    db.add("definesMethodFrom", ["f.rb:0-40", "f.rb:10-13"]);
    db.add("definesMethodFrom", ["f.rb#Subject", "f.rb#name"]);
    db.add("elementOf", ["key", "f.rb#KEYS"]);
    db.add("elementOf", ["f.rb#key", "f.rb#KEYS"]);
    db.add("positionOf", ["at", "f.rb#key"]);

    const names = readDynamicNames(db, new Map());
    expect(names.get("f.rb:0-40")).toEqual({
      names: new Set(),
      patterns: [],
      unreadable: true,
    });
    expect(names.get("f.rb#Subject")?.unreadable).toBe(true);
  });
});
