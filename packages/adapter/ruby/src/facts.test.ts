import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitEntryFact, unitKey } from "./facts.js";

describe("unitKey", () => {
  it("joins the file path and range into one stable string", () => {
    expect(unitKey("types/campaign_type.rb", { start: 10, end: 40 })).toBe(
      "types/campaign_type.rb:10-40",
    );
  });
});

describe("emitEntryFact", () => {
  it("records one entry fact keyed by file and range", () => {
    const db = new Database();
    emitEntryFact(db, "types/campaign_type.rb", { start: 10, end: 40 });
    expect(db.facts("entry")).toEqual([["types/campaign_type.rb:10-40"]]);
  });
});
