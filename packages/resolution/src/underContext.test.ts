import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  askResolution,
  askResolutionUnder,
  resolutionUnderProgram,
} from "./program.js";
import {
  allocationSitesOf,
  comesToUnder,
  isWrittenAsUnder,
  objectOfUnder,
  writtenValueUnder,
} from "./underContext.js";

// class Api { constructor(base) { this.client = axios.create(base) } }, with
// two module-level constructions, new Api(urlA) and new Api(urlB).
const TWO_CLIENTS: Array<[string, ...string[]]> = [
  ["objectValue", "Api"],
  ["initializes", "Api", "Api"],
  ["paramOf", "Api", "0", "base"],
  ["writtenValue", "created"],
  ["storesProperty", "Api", "client", "created"],
  ["binds", "ApiRef", "Api"],
  ["call", "v1Site", "ApiRef"],
  ["writtenValue", "v1Site"],
  ["callOutsideMethod", "v1Site"],
  ["callArg", "v1Site", "0", "urlA"],
  ["writtenValue", "urlA"],
  ["binds", "v1", "v1Site"],
  ["call", "v2Site", "ApiRef"],
  ["writtenValue", "v2Site"],
  ["callOutsideMethod", "v2Site"],
  ["callArg", "v2Site", "0", "urlB"],
  ["writtenValue", "urlB"],
  ["binds", "v2", "v2Site"],
  ["readsProperty", "v1Client", "v1", "client"],
];

function askedDb(pairs: Array<[string, string]>): Database {
  const db = new Database();
  for (const [relation, ...tuple] of TWO_CLIENTS) {
    db.add(relation, tuple);
  }
  askResolutionUnder(db, pairs, resolutionUnderProgram());
  return db;
}

describe("reading an answer under one allocation site", () => {
  it("gives each construction its own argument", () => {
    const db = askedDb([
      ["base", "v1Site"],
      ["base", "v2Site"],
    ]);

    expect(isWrittenAsUnder(db, "base", "v1Site")).toEqual(["urlA"]);
    expect(isWrittenAsUnder(db, "base", "v2Site")).toEqual(["urlB"]);
  });

  it("gives nothing back for a pair nobody asked about", () => {
    const db = askedDb([["base", "v1Site"]]);

    expect(isWrittenAsUnder(db, "base", "v2Site")).toEqual([]);
  });

  it("reads a field off a name for the construction", () => {
    const db = askedDb([["v1Client", "v1Site"]]);

    expect(isWrittenAsUnder(db, "v1Client", "v1Site")).toEqual(["created"]);
  });

  it("gives back the class a name comes to and the site it refers to", () => {
    const db = askedDb([["v1", "v1Site"]]);

    expect(comesToUnder(db, "v1", "v1Site")).toEqual(["Api"]);
    expect(objectOfUnder(db, "v1", "v1Site")).toEqual(["v1Site"]);
  });

  it("settles on the one answer a site gives, and declines two", () => {
    const db = askedDb([
      ["base", "v1Site"],
      ["base", "v2Site"],
    ]);
    db.add("wantedIsWrittenAsUnder", ["base", "v2Site", "urlC"]);

    expect(writtenValueUnder(db, "base", "v1Site")).toBe("urlA");
    expect(writtenValueUnder(db, "base", "v2Site")).toBe(null);
    expect(writtenValueUnder(db, "base", "noSite")).toBe(null);
  });

  it("costs nothing to ask the same pair twice", () => {
    const db = askedDb([["base", "v1Site"]]);
    const before = db.size("wantedIsWrittenAsUnder");

    askResolutionUnder(db, [["base", "v1Site"]], resolutionUnderProgram());

    expect(db.size("wantedIsWrittenAsUnder")).toBe(before);
  });
});

describe("where a class was made", () => {
  function sitesIn(facts: Array<[string, ...string[]]>): string[] {
    const db = new Database();
    for (const [relation, ...tuple] of facts) {
      db.add(relation, tuple);
    }
    askResolution(db, ["Api"], "wantedSites");
    return allocationSitesOf(db, "Api");
  }

  it("gives every construction written with the class's name", () => {
    expect(sitesIn(TWO_CLIENTS).sort()).toEqual(["v1Site", "v2Site"]);
  });

  it("gives nothing for a class nothing constructs", () => {
    expect(
      sitesIn([
        ["objectValue", "Api"],
        ["initializes", "Api", "Api"],
      ]),
    ).toEqual([]);
  });
});
