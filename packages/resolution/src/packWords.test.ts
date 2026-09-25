import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { addPackWords } from "./packWords.js";

/** The rows of one relation, as strings, in the order they went in. */
function rows(db: Database, relation: string): string[][] {
  return db.facts(relation).map((row) => row.map(String));
}

describe("the facts a pack states about its own library", () => {
  it("adds one row for each word", () => {
    const db = new Database();
    addPackWords(db, {
      givesBackOne: [{ base: "ActiveRecord::Base", method: "find" }],
      givesBackOneOfArgument: [
        { base: "DeclarativeBase", method: "get", argument: 0 },
      ],
      givesBackOneOfImport: [
        { module: "sqlalchemy", name: "select", argument: 0 },
      ],
      entersAsSelf: [{ module: "httpx", name: "Client" }],
      unwrapsByName: [
        { module: "@sentry/aws-serverless", name: "wrapHandler", argument: 0 },
      ],
      associationConstructor: [
        { module: "sqlalchemy.orm", name: "relationship" },
      ],
    });

    expect(rows(db, "givesBackOne")).toEqual([["ActiveRecord::Base", "find"]]);
    expect(rows(db, "givesBackOneOfArgument")).toEqual([
      ["DeclarativeBase", "get", "0"],
    ]);
    expect(rows(db, "givesBackOneOfImport")).toEqual([
      ["sqlalchemy", "select", "0"],
    ]);
    expect(rows(db, "entersAsSelf")).toEqual([["httpx", "Client"]]);
    expect(rows(db, "unwrapsByName")).toEqual([
      ["@sentry/aws-serverless", "wrapHandler", "0"],
    ]);
    expect(rows(db, "associationConstructor")).toEqual([
      ["sqlalchemy.orm", "relationship"],
    ]);
  });

  it("adds nothing for a run whose packs declared nothing", () => {
    const db = new Database();
    addPackWords(db, {});
    for (const relation of [
      "givesBackOne",
      "givesBackOneOfArgument",
      "givesBackOneOfImport",
      "entersAsSelf",
      "unwrapsByName",
      "associationConstructor",
    ]) {
      expect(db.size(relation)).toBe(0);
    }
  });

  it("leaves one row behind when two packs declare the same word", () => {
    const db = new Database();
    addPackWords(db, {
      givesBackOne: [
        { base: "ActiveRecord::Base", method: "find" },
        { base: "ActiveRecord::Base", method: "find" },
      ],
    });
    expect(rows(db, "givesBackOne")).toEqual([["ActiveRecord::Base", "find"]]);
  });
});
