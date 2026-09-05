import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
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
