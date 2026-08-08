import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitEntryFact, unitKey } from "./facts.js";

describe("unitKey", () => {
  it("joins the file path, the lines, and the name", () => {
    expect(
      unitKey("types/campaign_type.rb", { start: 10, end: 40 }, "Campaign.id"),
    ).toBe("types/campaign_type.rb:10-40#Campaign.id");
  });

  it("tells two fields on one line apart", () => {
    // `field :id, ID; field :name, String` is one line and two units.
    // The range is lines, so without the name in the key they are one
    // key, and `entry` is a set, so the second one disappears from it.
    const range = { start: 2, end: 2 };
    expect(unitKey("types/campaign_type.rb", range, "Campaign.id")).not.toBe(
      unitKey("types/campaign_type.rb", range, "Campaign.name"),
    );
  });
});

describe("emitEntryFact", () => {
  it("records one entry fact keyed by file, lines, and name", () => {
    const db = new Database();
    emitEntryFact(
      db,
      "types/campaign_type.rb",
      { start: 10, end: 40 },
      "Campaign.id",
    );
    expect(db.facts("entry")).toEqual([
      ["types/campaign_type.rb:10-40#Campaign.id"],
    ]);
  });

  it("keeps both units when two fields share a line", () => {
    const db = new Database();
    const range = { start: 2, end: 2 };
    emitEntryFact(db, "types/campaign_type.rb", range, "Campaign.id");
    emitEntryFact(db, "types/campaign_type.rb", range, "Campaign.name");
    expect(db.facts("entry")).toHaveLength(2);
  });
});
