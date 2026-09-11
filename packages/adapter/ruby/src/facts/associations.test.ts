import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
import { emitValueFacts } from "./values.js";

import type { RbAssociationCalls } from "../pack.js";

/** ActiveRecord's own four calls, as the pack declares them. */
const ACTIVE_RECORD: RbAssociationCalls = {
  singular: ["has_one", "belongs_to"],
  plural: ["has_many", "has_and_belongs_to_many"],
  classNameKeyword: "class_name",
};

async function factsFor(files: Record<string, string>) {
  const db = new Database();
  const constants = [];
  for (const [file, source] of Object.entries(files)) {
    const tree = await parseRuby(source);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode, [ACTIVE_RECORD]));
  }
  emitConstantBindings(db, constants);
  return db;
}

/** Every association a run declares, as `name -> the qualified name its target binds to`. */
function targetsOf(db: Database): Record<string, string> {
  const named = new Map(
    db.facts("rbConstantName").map((row) => [String(row[0]), String(row[1])]),
  );
  const bound = new Map(
    db.facts("binds").map((row) => [String(row[0]), String(row[1])]),
  );
  const targets: Record<string, string> = {};
  for (const row of db.facts("declaresAssociation")) {
    const definition = bound.get(String(row[2]));
    targets[String(row[1])] =
      definition === undefined ? "" : (named.get(definition) ?? "");
  }
  return targets;
}

describe("an association ActiveRecord declares", () => {
  it("is read from each of the four calls", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "class Profile; end",
        "class Account; end",
        "class Tag; end",
        "",
        "class User",
        "  has_many :statuses",
        "  has_one :profile",
        "  belongs_to :account",
        "  has_and_belongs_to_many :tags",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({
      statuses: "Status",
      profile: "Profile",
      account: "Account",
      tags: "Tag",
    });
  });

  it("takes the class the declaration writes over the one its name would give", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class User",
        "  has_many :toots, class_name: 'Status'",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ toots: "Status" });
  });

  it("says nothing when the written class is not a plain string", async () => {
    const db = await factsFor({
      "models.rb": [
        "class User",
        '  has_many :toots, class_name: "Status\#{suffix}"',
        "end",
        "",
      ].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("reaches a class under the same namespace before the top-level one", async () => {
    const db = await factsFor({
      "top.rb": "class Status; end\n",
      "admin.rb": [
        "module Admin",
        "  class Status; end",
        "",
        "  class Account",
        "    has_many :statuses",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Admin::Status" });
  });

  it("is read inside an `included do` block of a concern", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "module Account::Associations",
        "  extend ActiveSupport::Concern",
        "",
        "  included do",
        "    with_options dependent: :destroy do",
        "      has_many :statuses",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("belongs to the class whose body writes it, not a class nested in it", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class Account",
        "  has_many :statuses",
        "",
        "  class Draft",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    const account = db
      .facts("rbConstantName")
      .find((row) => String(row[1]) === "Account");
    expect(
      db.facts("declaresAssociation").map((row) => String(row[0])),
    ).toEqual([String(account?.[0])]);
  });

  it("reads a name written as a string", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class User",
        '  has_many "statuses"',
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("reads a written class pinned to the top level past a nearer one", async () => {
    const db = await factsFor({
      "top.rb": "class Status; end\n",
      "admin.rb": [
        "module Admin",
        "  class Status; end",
        "",
        "  class Account",
        "    has_many :statuses, class_name: '::Status'",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("says nothing for a call that names no association", async () => {
    const db = await factsFor({
      "models.rb": [
        "class User",
        "  has_many class_name: 'Status'",
        "end",
        "",
      ].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("says nothing when the name is neither a symbol nor a string", async () => {
    const db = await factsFor({
      "models.rb": ["class User", "  has_many STATUSES", "end", ""].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("is left out when no pack says what one looks like", async () => {
    const db = new Database();
    const tree = await parseRuby("class Account\n  has_many :statuses\nend\n");
    emitValueFacts(db, "models.rb", tree.rootNode);
    emitConstantBindings(db, [
      collectFileConstants("models.rb", tree.rootNode),
    ]);

    expect(db.size("declaresAssociation")).toBe(0);
  });
});
