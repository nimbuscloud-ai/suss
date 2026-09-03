import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { emitValueFacts } from "./values.js";

async function factsFor(source: string) {
  const tree = await parseRuby(source);
  const db = new Database();
  emitValueFacts(db, "f.rb", tree.rootNode);
  return db;
}

/** The tuples of one relation, with the file prefix dropped so a test reads. */
function rows(db: Database, relation: string): string[][] {
  return db
    .facts(relation)
    .map((row) => row.map((value) => String(value).replace("f.rb", "")));
}

describe("ruby value facts", () => {
  it("says a def is a function and binds its name to it", async () => {
    const db = await factsFor("def handler\nend\n");
    expect(db.size("func")).toBe(1);
    expect(rows(db, "binds")[0]?.[0]).toBe("#handler");
  });

  it("gives each parameter its position, keyed under the method that declares it", async () => {
    const db = await factsFor("def handler(a, b)\nend\n");
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "paramOf").map((row) => [row[1], row[2]])).toEqual([
      ["0", `${funcKey}#a`],
      ["1", `${funcKey}#b`],
    ]);
  });

  it("records what an explicit return gives back", async () => {
    const db = await factsFor("def handler\n  return other\nend\n");
    expect(rows(db, "returnsValue").map((row) => row[1])).toContain("#other");
  });

  it("records the last expression as the return, which Ruby does implicitly", async () => {
    const db = await factsFor("def handler\n  compute\nend\n");
    expect(rows(db, "returnsValue").map((row) => row[1])).toContain("#compute");
  });

  it("keeps an array's elements under their positions", async () => {
    const db = await factsFor("items = [first, second]\n");
    expect(db.size("objectValue")).toBe(1);
    expect(rows(db, "holdsProperty").map((row) => [row[1], row[2]])).toEqual([
      ["0", "#first"],
      ["1", "#second"],
    ]);
  });

  it("keeps a hash's values under their keys, symbol or string", async () => {
    const db = await factsFor(
      "config = { host: host_name, 'port' => port_value }\n",
    );
    expect(rows(db, "holdsProperty").map((row) => [row[1], row[2]])).toEqual([
      ["host", "#host_name"],
      ["port", "#port_value"],
    ]);
  });

  it("records a call, its callee and its positional arguments", async () => {
    const db = await factsFor("build(first, second)\n");
    expect(rows(db, "call")[0]?.[1]).toBe("#build");
    expect(rows(db, "callArg").map((row) => [row[1], row[2]])).toEqual([
      ["0", "#first"],
      ["1", "#second"],
    ]);
  });

  it("records a keyword argument under its name", async () => {
    const db = await factsFor("build(prefix: value)\n");
    expect(db.size("callArg")).toBe(0);
    expect(rows(db, "callKeywordArg").map((row) => [row[1], row[2]])).toEqual([
      ["prefix", "#value"],
    ]);
  });

  it("reads a receiver call with no arguments as a property read", async () => {
    const db = await factsFor("value = config.host\n");
    expect(rows(db, "readsProperty")[0]?.slice(1)).toEqual(["#config", "host"]);
    expect(db.size("call")).toBe(0);
  });

  it("still reads a receiver call with arguments as a call, whose callee reads the receiver", async () => {
    const db = await factsFor("value = config.fetch(key)\n");
    expect(db.size("call")).toBe(1);
    expect(rows(db, "readsProperty")[0]?.slice(1)).toEqual([
      "#config",
      "fetch",
    ]);
  });

  it("binds a name to what an assignment writes", async () => {
    const db = await factsFor("alias_name = original\n");
    expect(rows(db, "binds")).toEqual([["#alias_name", "#original"]]);
  });

  it("binds a constant the same way", async () => {
    const db = await factsFor("Registry = builder\n");
    expect(rows(db, "binds")).toEqual([["#Registry", "#builder"]]);
  });

  it("gives a nested method its own returns rather than the outer one's", async () => {
    const db = await factsFor(
      ["class Outer", "  def inner", "    deep", "  end", "end", ""].join("\n"),
    );
    expect(rows(db, "returnsValue").map((row) => row[1])).toContain("#deep");
  });

  it("records the calls a method's body makes", async () => {
    const db = await factsFor("def handler\n  log(event)\nend\n");
    expect(db.size("bodyCalls")).toBe(1);
  });
  it("reads a plain symbol key on a hash", async () => {
    const db = await factsFor("config = { :host => host_name }\n");
    expect(rows(db, "holdsProperty").map((row) => [row[1], row[2]])).toEqual([
      ["host", "#host_name"],
    ]);
  });

  it("skips a hash key that is not written as a symbol or a string", async () => {
    const db = await factsFor("table = { key_name => value }\n");
    expect(db.size("holdsProperty")).toBe(0);
    expect(db.size("objectValue")).toBe(1);
  });

  it("skips a keyword argument whose key is not written plainly", async () => {
    const db = await factsFor("build(key_name => value)\n");
    expect(db.size("callKeywordArg")).toBe(0);
  });

  it("records a method declared inside another as nested", async () => {
    const db = await factsFor(
      ["def outer", "  def inner", "    deep", "  end", "end", ""].join("\n"),
    );
    expect(db.size("containsFn")).toBe(1);
  });

  it("binds nothing when an assignment writes to something other than a name", async () => {
    const db = await factsFor("config[key] = value\n");
    expect(db.size("binds")).toBe(0);
  });

  it("says a literal is written out in the source", async () => {
    const db = await factsFor('name = "orders"\n');
    expect(db.size("writtenValue")).toBe(1);
  });

  it("claims no implicit return for a method whose body ends in a return", async () => {
    const db = await factsFor("def handler\n  return other\nend\n");
    expect(db.size("returnsValue")).toBe(1);
  });
  it("skips a hash entry that is not a pair", async () => {
    const db = await factsFor("merged = { **defaults }\n");
    expect(db.size("objectValue")).toBe(1);
    expect(db.size("holdsProperty")).toBe(0);
  });
  it("makes a class an object containing its methods", async () => {
    const db = await factsFor("class Loader\n  def load\n  end\nend\n");
    const [cls] = rows(db, "objectValue");
    const [method] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [cls?.[0], "load", method?.[0]],
    ]);
  });

  it("makes a module an object containing its singleton methods", async () => {
    const db = await factsFor("module Helpers\n  def self.fetch\n  end\nend\n");
    const [mod] = rows(db, "objectValue");
    const [method] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [mod?.[0], "fetch", method?.[0]],
    ]);
  });

  it("gives a nested module its own object, apart from its enclosing one", async () => {
    const db = await factsFor(
      "module A\n  module B\n    def self.fetch\n    end\n  end\nend\n",
    );
    const objects = rows(db, "objectValue").map((row) => row[0]);
    expect(objects).toHaveLength(2);
    const [method] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [objects[1], "fetch", method?.[0]],
    ]);
  });

  it("resolves a module_function method the same way as one written with self.", async () => {
    const db = await factsFor(
      "module Helpers\n  module_function\n\n  def fetch\n  end\nend\n",
    );
    const [mod] = rows(db, "objectValue");
    const [method] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [mod?.[0], "fetch", method?.[0]],
    ]);
  });

  it("keeps two classes' methods of one name apart", async () => {
    const db = await factsFor(
      "class First\n  def load\n  end\nend\n\nclass Second\n  def load\n  end\nend\n",
    );
    expect(rows(db, "binds").map((row) => row[0])).toEqual([
      "#First",
      "#Second",
    ]);
  });

  it("keeps a class constant under its name", async () => {
    const db = await factsFor("class Loader\n  REGISTRY = built\nend\n");
    expect(rows(db, "holdsProperty")[0]?.slice(1)).toEqual([
      "REGISTRY",
      "#built",
    ]);
  });

  it("reads a call with a receiver off the receiver rather than off the file", async () => {
    const db = await factsFor("loader.load(key)\n");
    const [callee] = rows(db, "call").map((row) => row[1]);
    expect(rows(db, "readsProperty")).toEqual([[callee, "#loader", "load"]]);
  });

  it("says which class a class is written as extending", async () => {
    const db = await factsFor("class Order < ApplicationRecord\nend\n");
    const [cls] = rows(db, "objectValue");
    expect(rows(db, "extendsNamed")).toEqual([[cls?.[0], "ApplicationRecord"]]);
    expect(rows(db, "extends")).toEqual([[cls?.[0], "#ApplicationRecord"]]);
  });

  it("says nothing about a class written with no superclass", async () => {
    const db = await factsFor("class Order\nend\n");
    expect(db.size("extendsNamed")).toBe(0);
  });
});
