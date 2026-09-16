import { describe, expect, it } from "vitest";

import { Database, notLit, rule, variable } from "@suss/datalog";

import {
  askResolution,
  askResolutionUnder,
  resolutionUnderProgram,
  UNDER_QUESTION_ROW_BUDGET,
  underQuestionSpend,
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

describe("a question that runs past its budget", () => {
  function factsDb(): Database {
    const db = new Database();
    for (const [relation, ...tuple] of TWO_CLIENTS) {
      db.add(relation, tuple);
    }
    return db;
  }

  const askWithin = (db: Database, rows: number): string =>
    askResolutionUnder(
      db,
      [["base", "v1Site"]],
      resolutionUnderProgram(),
      rows,
    );

  it("is given up on and says so", () => {
    expect(askWithin(factsDb(), 1)).toBe("abandoned");
  });

  it("leaves no answer and no question behind", () => {
    const db = factsDb();
    askWithin(db, 1);

    expect(isWrittenAsUnder(db, "base", "v1Site")).toEqual([]);
    expect(writtenValueUnder(db, "base", "v1Site")).toBe(null);
    expect(db.size("wantedUnder")).toBe(0);
  });

  it("is not asked again, even with room to answer it", () => {
    const db = factsDb();
    askWithin(db, 1);

    expect(askWithin(db, 1_000_000)).toBe("answered");
    expect(isWrittenAsUnder(db, "base", "v1Site")).toEqual([]);
  });

  it("leaves the next question able to answer", () => {
    const db = factsDb();
    askWithin(db, 1);

    askResolutionUnder(db, [["base", "v2Site"]], resolutionUnderProgram());

    expect(isWrittenAsUnder(db, "base", "v2Site")).toEqual(["urlB"]);
  });

  it("charges what it read against the run, answered or not", () => {
    const db = factsDb();
    askResolutionUnder(db, [["base", "v1Site"]], resolutionUnderProgram());
    const afterOne = underQuestionSpend(db);

    askResolutionUnder(db, [["base", "v2Site"]], resolutionUnderProgram());
    const afterTwo = underQuestionSpend(db);

    expect(afterOne.rows).toBeGreaterThan(0);
    expect(afterTwo.rows).toBeGreaterThan(afterOne.rows);
    expect(afterTwo.asked).toBe(2);
  });

  it("hands back anything else the rules throw", () => {
    const malformed = {
      rules: [rule("bad", [variable("x")], [notLit("blocked", variable("z"))])],
      demandDriven: [],
      demands: [],
    };

    expect(() =>
      askResolutionUnder(factsDb(), [["base", "v1Site"]], malformed),
    ).toThrow('unbound variable "z"');
  });
});

describe("a run that has spent its rows on questions", () => {
  function factsDb(): Database {
    const db = new Database();
    for (const [relation, ...tuple] of TWO_CLIENTS) {
      db.add(relation, tuple);
    }
    return db;
  }

  /** Enough for one question and not for a second. */
  const runOf = (rows: number) => (db: Database, pair: [string, string]) =>
    askResolutionUnder(
      db,
      [pair],
      resolutionUnderProgram(),
      UNDER_QUESTION_ROW_BUDGET,
      rows,
    );

  it("answers what it can afford and gives up the rest", () => {
    const db = factsDb();
    const ask = runOf(1);

    expect(ask(db, ["base", "v1Site"])).toBe("answered");
    expect(ask(db, ["base", "v2Site"])).toBe("abandoned");
    expect(isWrittenAsUnder(db, "base", "v1Site")).toEqual(["urlA"]);
    expect(isWrittenAsUnder(db, "base", "v2Site")).toEqual([]);
  });

  it("never puts the question it cannot afford", () => {
    const db = factsDb();
    const ask = runOf(1);
    ask(db, ["base", "v1Site"]);
    const before = db.size("wantedUnder");

    ask(db, ["base", "v2Site"]);

    expect(db.size("wantedUnder")).toBe(before);
    expect(underQuestionSpend(db).skipped).toBe(1);
  });

  it("counts every question it was asked, spent or not", () => {
    const db = factsDb();
    const ask = runOf(1);
    ask(db, ["base", "v1Site"]);
    ask(db, ["base", "v2Site"]);

    const spend = underQuestionSpend(db);
    expect(spend.asked).toBe(2);
    expect(spend.skipped).toBe(1);
    expect(spend.abandoned).toBe(0);
  });

  it("asks everything when the run has rows to spare", () => {
    const db = factsDb();
    const ask = runOf(10_000_000);

    expect(ask(db, ["base", "v1Site"])).toBe("answered");
    expect(ask(db, ["base", "v2Site"])).toBe("answered");
    expect(underQuestionSpend(db).skipped).toBe(0);
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
