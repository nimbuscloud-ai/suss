import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
import { resolveValues, writtenValueOf } from "./resolve.js";
import { emitValueFacts } from "./values.js";

async function factsFor(source: string) {
  const tree = await parseRuby(source);
  const db = new Database();
  emitValueFacts(db, "f.rb", tree.rootNode);
  return db;
}

describe("resolving a value across a Ruby file", () => {
  it("derives a call reached through a wrapper as written by the construction it returns", async () => {
    const db = await factsFor(
      [
        "class Client",
        "end",
        "",
        "def make_client",
        "  Client.new",
        "end",
        "",
        "make_client().send_request(1)",
      ].join("\n"),
    );

    const wrapperCall = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#make_client"));
    expect(wrapperCall, "the wrapper call was not recorded").toBeDefined();
    const clientClass = db.facts("objectValue")[0];
    expect(clientClass, "the class was not recorded").toBeDefined();

    resolveValues(db, [String(wrapperCall?.[0])]);
    const written = db
      .facts("wantedIsWrittenAs")
      .filter((row) => row[0] === wrapperCall?.[0])
      .map((row) => String(row[1]));
    expect(written).toContain(String(clientClass?.[0]));
  });

  it("settles a name bound to a wrapper call on the construction the wrapper returns", async () => {
    const db = await factsFor(
      [
        "def build_client",
        "  connect()",
        "end",
        "",
        "table = build_client()",
      ].join("\n"),
    );

    const construction = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    const nameKey = "f.rb#table";
    resolveValues(db, [nameKey]);
    expect(writtenValueOf(db, nameKey)).toBe(String(construction?.[0]));
  });

  it("settles a call to a wrapper on the construction the wrapper returns", async () => {
    const db = await factsFor(
      [
        "def build_client",
        "  connect()",
        "end",
        "",
        "build_client().send_request(1)",
      ].join("\n"),
    );

    const wrapperCall = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#build_client"));
    expect(wrapperCall, "the wrapper call was not recorded").toBeDefined();
    const construction = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    resolveValues(db, [String(wrapperCall?.[0])]);
    expect(writtenValueOf(db, String(wrapperCall?.[0]))).toBe(
      String(construction?.[0]),
    );
  });

  it("asks about a key on its own", async () => {
    const db = await factsFor("value = 1\n");
    expect(writtenValueOf(db, "f.rb#value")).toBe("f.rb:8-9");
  });

  it("returns null for a name nothing writes", async () => {
    const db = await factsFor("value = 1\n");
    expect(writtenValueOf(db, "f.rb#other")).toBeNull();
  });

  it("settles a name written as a literal on that literal", async () => {
    const db = await factsFor("value = 1\n");
    const literal = db.facts("writtenValue")[0];
    expect(literal, "the literal was not recorded").toBeDefined();

    const nameKey = "f.rb#value";
    resolveValues(db, [nameKey]);
    expect(writtenValueOf(db, nameKey)).toBe(String(literal?.[0]));
  });

  it("settles a name written as nil and then as a construction behind a guard", async () => {
    const db = await factsFor(
      [
        "client = nil",
        "client = connect() if client.nil?",
        "client.send_request(1)",
      ].join("\n"),
    );

    const construction = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    const nameKey = "f.rb#client";
    resolveValues(db, [nameKey]);
    expect(writtenValueOf(db, nameKey)).toBe(String(construction?.[0]));
  });

  it("keeps nil for a name written only as nil", async () => {
    const db = await factsFor("value = nil\n");
    const placeholder = db.facts("placeholderValue")[0];
    expect(placeholder, "the nil was not recorded").toBeDefined();

    const nameKey = "f.rb#value";
    resolveValues(db, [nameKey]);
    expect(writtenValueOf(db, nameKey)).toBe(String(placeholder?.[0]));
  });
});

/** A whole run's facts, so a constant read reaches the class it refers to. */
async function runFactsFor(source: string) {
  const tree = await parseRuby(source);
  const db = new Database();
  emitValueFacts(db, "f.rb", tree.rootNode);
  emitConstantBindings(db, [collectFileConstants("f.rb", tree.rootNode)]);
  return db;
}

/** Rails' own two-class ancestry, with the library base above both. */
const MODEL_SOURCE = [
  "class ApplicationRecord < ActiveRecord::Base",
  "end",
  "",
  "class Account < ApplicationRecord",
  "end",
  "",
].join("\n");

function objectsBehind(db: Database, key: string): string[] {
  resolveValues(db, [key]);
  return db
    .facts("wantedObjectOf")
    .filter((row) => String(row[0]) === key)
    .map((row) => String(row[1]));
}

/** The key of the class a constant read is bound to. */
function classBehind(db: Database, constantKey: string): string {
  const bound = db.facts("binds").find((row) => String(row[0]) === constantKey);
  return String(bound?.[1]);
}

describe("a finder Ruby writes with no arguments", () => {
  it("steps a bare read of one to the class its ancestry reaches the base from", async () => {
    const db = await runFactsFor(`${MODEL_SOURCE}account = Account.first\n`);
    db.add("givesBackOne", ["ActiveRecord::Base", "first"]);

    expect(objectsBehind(db, "f.rb#account")).toEqual([
      classBehind(db, "f.rb#Account"),
    ]);
  });

  it("says nothing when the pack declares no method of that name", async () => {
    const db = await runFactsFor(`${MODEL_SOURCE}account = Account.sample\n`);
    db.add("givesBackOne", ["ActiveRecord::Base", "first"]);

    expect(objectsBehind(db, "f.rb#account")).toEqual([]);
  });
});

describe("a method Ruby runs by reading it off a constant", () => {
  /** The list written out in the source, which is the object holding an element at position 0. */
  const listOf = (db: Database): string =>
    String(
      db.facts("holdsProperty").find((row) => String(row[1]) === "0")?.[0],
    );

  /** The `Settings.filters` read, which is what the evaluator asks about. */
  const readOf = (db: Database): string =>
    String(
      db
        .facts("readsProperty")
        .find((row) => String(row[1]).endsWith("#Settings"))?.[0],
    );

  it("is worth what the method gives back", async () => {
    const db = await runFactsFor(
      [
        "class Settings",
        "  def self.filters",
        "    %i[latest unread]",
        "  end",
        "end",
        "",
        "chosen = Settings.filters",
        "",
      ].join("\n"),
    );

    expect(writtenValueOf(db, readOf(db))).toBe(listOf(db));
  });

  it("reads the memoised spelling, frozen or not", async () => {
    const db = await runFactsFor(
      [
        "class Settings",
        "  def self.periods",
        "    @@periods ||= %i[daily weekly].freeze",
        "  end",
        "end",
        "",
        "chosen = Settings.periods",
        "",
      ].join("\n"),
    );

    expect(writtenValueOf(db, readOf(db))).toBe(listOf(db));
  });
});
