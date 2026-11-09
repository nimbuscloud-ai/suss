import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { boundByImport } from "./importBinding.js";

/**
 * The facts for, in TypeScript:
 *
 *   import { GetCommand as Get } from "@aws-sdk/lib-dynamodb";
 *   function send(next: () => void) { next(); new Get({}); new Date(); }
 *
 * and for a Python file that wrote `from kvcache import Cache as Store`.
 */
function facts(): Database {
  const db = new Database();
  db.add("binds", ["Get@use", "Get@import"]);
  db.add("imports", ["Get@import", "@aws-sdk/lib-dynamodb", "GetCommand"]);
  db.add("binds", ["next@use", "next@param"]);
  db.add("imports", ["Date@use", "<global>", "Date"]);
  db.add("imports", ["store.py#Store", "kvcache", "Cache"]);
  return db;
}

describe("boundByImport", () => {
  it("says a reference to an import is bound by one", () => {
    expect(boundByImport(facts(), "Get@use")).toBe(true);
  });

  it("says a name the facts state as imported is bound by an import", () => {
    expect(boundByImport(facts(), "store.py#Store")).toBe(true);
    expect(boundByImport(facts(), "Date@use")).toBe(true);
  });

  it("says a parameter, or a name with no facts, is not", () => {
    expect(boundByImport(facts(), "next@use")).toBe(false);
    expect(boundByImport(facts(), "helper@use")).toBe(false);
  });
});
