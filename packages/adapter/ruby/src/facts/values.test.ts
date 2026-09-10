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

/** The key the facts give a node, worked out from where its text starts in the source. */
function keyOf(source: string, text: string): string {
  const start = source.indexOf(text);
  return `:${start}-${start + text.length}`;
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

  it("reads the expressions a class body runs, which Ruby runs like any other code", async () => {
    const db = await factsFor(
      [
        "class Subject",
        "  Settings.filters.each do |filter|",
        "    define_method(filter) { 1 }",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    expect(rows(db, "readsProperty")[0]?.slice(1)).toEqual([
      "#Settings",
      "filters",
    ]);
  });

  it("gives back what an assignment on the last line wrote", async () => {
    const db = await factsFor(
      ["def filters", "  @filters ||= build", "end", ""].join("\n"),
    );
    expect(rows(db, "returnsValue").map((row) => row[1])).toContain("#build");
  });

  it("leaves the return unread when the last line combines with what is there", async () => {
    const db = await factsFor(
      ["def total", "  @total += one", "end", ""].join("\n"),
    );
    expect(rows(db, "returnsValue").map((row) => row[1])).not.toContain("#one");
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

  it("puts a module the class includes in the extends ancestry", async () => {
    const db = await factsFor("class Order\n  include Payable\nend\n");
    const [cls] = rows(db, "objectValue");
    expect(rows(db, "extends")).toEqual([[cls?.[0], "#Payable"]]);
  });

  it("puts a module the class prepends in the extends ancestry", async () => {
    const db = await factsFor("class Order\n  prepend Auditing\nend\n");
    const [cls] = rows(db, "objectValue");
    expect(rows(db, "extends")).toEqual([[cls?.[0], "#Auditing"]]);
  });

  it("leaves a mixin out of extendsNamed, which is for a library base alone", async () => {
    const db = await factsFor(
      "class Order < ApplicationRecord\n  include Payable\nend\n",
    );
    expect(rows(db, "extendsNamed").map((row) => row[1])).toEqual([
      "ApplicationRecord",
    ]);
  });

  it("reads a scope resolution mixin under the whole name it is written as", async () => {
    const source = "class Account\n  include Account::Associations\nend\n";
    const db = await factsFor(source);
    const [cls] = rows(db, "objectValue");
    expect(rows(db, "extends")).toEqual([
      [cls?.[0], keyOf(source, "Account::Associations")],
    ]);
  });

  it("orders prepends before includes, and include A, B in front of B", async () => {
    const db = await factsFor(
      [
        "class Order < ApplicationRecord",
        "  prepend Auditing",
        "  include A, B",
        "  include C",
        "end",
        "",
      ].join("\n"),
    );
    expect(rows(db, "extends").map((row) => row[1])).toEqual([
      "#Auditing",
      "#C",
      "#A",
      "#B",
      "#ApplicationRecord",
    ]);
  });

  it("reads a method an included do block declares as the module's own", async () => {
    const db = await factsFor(
      [
        "module Payable",
        "  included do",
        "    def pay",
        "      charge",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const [mod] = rows(db, "objectValue");
    const [func] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([[mod?.[0], "pay", func?.[0]]]);
  });

  it("reads a method a with_options block declares as the class's own", async () => {
    const db = await factsFor(
      [
        "class Order",
        "  with_options dependent: :destroy do",
        "    def pay",
        "      charge",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const [cls] = rows(db, "objectValue");
    const [func] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([[cls?.[0], "pay", func?.[0]]]);
  });

  it("reads through a with_options block nested in an included do block", async () => {
    const db = await factsFor(
      [
        "module Account::Associations",
        "  included do",
        "    with_options dependent: :destroy do",
        "      def statuses",
        "        relation",
        "      end",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const [mod] = rows(db, "objectValue");
    const [func] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [mod?.[0], "statuses", func?.[0]],
    ]);
  });

  it("leaves an included do block in a class alone, since nothing includes a class", async () => {
    const db = await factsFor(
      "class Order\n  included do\n    def pay\n    end\n  end\nend\n",
    );
    expect(db.size("holdsProperty")).toBe(0);
  });

  it("keys a local under the method that writes it, so two methods keep two names", async () => {
    const db = await factsFor(
      [
        "class C",
        "  def one",
        "    query = A.new",
        "  end",
        "",
        "  def two",
        "    query = B.new",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const [first, second] = rows(db, "func").map((row) => row[0]);
    expect(
      rows(db, "binds")
        .map((row) => row[0])
        .filter((key) => key?.endsWith("#query")),
    ).toEqual([`${first}#query`, `${second}#query`]);
  });

  it("binds a local written once to what that write says", async () => {
    const db = await factsFor("def act\n  query = build\nend\n");
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "binds")).toContainEqual([`${funcKey}#query`, "#build"]);
  });

  it("keeps a method's local out of what the file exports", async () => {
    const db = await factsFor("def act\n  query = build\nend\n");
    expect(rows(db, "exportsAs").map((row) => row[1])).toEqual(["act"]);
  });

  it("settles a name written as nil and then built under an if on the thing it builds", async () => {
    const source = [
      "def act",
      "  x = nil",
      "  x = Foo.new if flag",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([
      [`${funcKey}#x`, keyOf(source, "Foo.new")],
    ]);
  });

  it("settles two writes that are both statements of the body on the last one", async () => {
    const source = [
      "def act",
      "  q = Entity.all",
      "  q = Other.all",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([
      [`${funcKey}#q`, keyOf(source, "Other.all")],
    ]);
  });

  it("settles a name narrowed by a call on itself on the write the call started from", async () => {
    const source = [
      "def act",
      "  q = Entity.all",
      "  q = q.where(a: 1)",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([
      [`${funcKey}#q`, keyOf(source, "Entity.all")],
    ]);
  });

  it("counts a narrowing write through an attribute reader, which Ruby writes as a call too", async () => {
    const source = [
      "def act",
      "  q = Entity.all",
      "  q = q.list",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([
      [`${funcKey}#q`, keyOf(source, "Entity.all")],
    ]);
  });

  it("settles nothing when the second of two writes is under an if", async () => {
    const db = await factsFor(
      [
        "def act",
        "  q = Entity.all",
        "  q = Other.all if flag",
        "end",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(db.size("endsHolding")).toBe(0);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#q`,
    );
  });

  it("names each write to a name the writes leave undecided", async () => {
    const source = [
      "def act",
      "  q = Entity.all",
      "  q = Other.all if flag",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "mayHold")).toEqual([
      [`${funcKey}#q`, keyOf(source, "Entity.all")],
      [`${funcKey}#q`, keyOf(source, "Other.all")],
    ]);
  });

  it("leaves a narrowing write out of the values a name may hold", async () => {
    const source = [
      "def act",
      "  q = Entity.all",
      "  q = Other.all if flag",
      "  q = q.where(a: 1) if flag",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    expect(rows(db, "mayHold").map((row) => row[1])).toEqual([
      keyOf(source, "Entity.all"),
      keyOf(source, "Other.all"),
    ]);
  });

  it("says a for-loop target is written with no value of its own", async () => {
    const db = await factsFor("for row in rows\n  row\nend\n");
    expect(rows(db, "writesUnstated")).toEqual([["#row"]]);
  });

  it("says a block parameter is written with no value of its own", async () => {
    const source = "def act\n  rows.each { |row| row }\nend\n";
    const db = await factsFor(source);
    const block = source.indexOf("{ |row| row }");
    expect(rows(db, "writesUnstated")).toEqual([
      [`:${block}-${block + "{ |row| row }".length}#row`],
    ]);
  });

  it("leaves a method parameter out, because paramNamed already says what it is", async () => {
    const db = await factsFor("def act(scope)\n  scope\nend\n");
    expect(db.size("writesUnstated")).toBe(0);
    expect(db.size("mayHold")).toBe(0);
  });

  it("settles nothing when a statement reads the name before the last write", async () => {
    const db = await factsFor(
      ["q = Entity.all", "log(q)", "q = Other.all", ""].join("\n"),
    );
    expect(db.size("endsHolding")).toBe(0);
  });

  it("reads a value through the parentheses it is written in", async () => {
    const source = "q = (Entity.all)\n";
    const db = await factsFor(source);
    expect(rows(db, "binds")).toContainEqual([
      "#q",
      keyOf(source, "Entity.all"),
    ]);
  });

  it("binds `self` to the class the method is written in, so a chain runs on", async () => {
    const source = "class Entity\n  def filter\n    self\n  end\nend\n";
    const db = await factsFor(source);
    const classKey = rows(db, "objectValue")[0]?.[0];
    expect(rows(db, "binds")).toContainEqual([keyOf(source, "self"), classKey]);
  });

  it("reads an instance variable as a property of the class it is written in", async () => {
    const source = "class C\n  def go\n    @thing\n  end\nend\n";
    const db = await factsFor(source);
    const classKey = rows(db, "objectValue")[0]?.[0];
    expect(rows(db, "readsProperty")).toContainEqual([
      keyOf(source, "@thing"),
      classKey,
      "@thing",
    ]);
  });

  it("puts what a method writes to an instance variable on the class", async () => {
    const source = "class C\n  def set\n    @thing = Entity.all\n  end\nend\n";
    const db = await factsFor(source);
    const classKey = rows(db, "objectValue")[0]?.[0];
    expect(rows(db, "holdsProperty")).toContainEqual([
      classKey,
      "@thing",
      keyOf(source, "Entity.all"),
    ]);
  });

  it("does not read the name an assignment writes to as a property", async () => {
    const source = "class C\n  def set\n    @thing = Entity.all\n  end\nend\n";
    const db = await factsFor(source);
    expect(rows(db, "readsProperty").map((row) => row[2])).not.toContain(
      "@thing",
    );
  });

  it("names both values when two methods write an instance variable differently", async () => {
    const source = [
      "class C",
      "  def one",
      "    @thing = First.all",
      "  end",
      "  def two",
      "    @thing = Second.all",
      "  end",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    expect(
      rows(db, "holdsProperty")
        .filter((row) => row[1] === "@thing")
        .map((row) => row[2]),
    ).toEqual([keyOf(source, "First.all"), keyOf(source, "Second.all")]);
  });

  it("leaves out a write that narrows an instance variable with a call on itself", async () => {
    const source = [
      "class C",
      "  def one",
      "    @thing = First.all",
      "  end",
      "  def two",
      "    @thing = @thing.where(a: 1)",
      "  end",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    expect(
      rows(db, "holdsProperty")
        .filter((row) => row[1] === "@thing")
        .map((row) => row[2]),
    ).toEqual([keyOf(source, "First.all")]);
  });

  it("says nothing about what `@count += 1` writes, since that value is written nowhere", async () => {
    const source = "class C\n  def go\n    @count += 1\n  end\nend\n";
    const db = await factsFor(source);
    expect(
      rows(db, "holdsProperty").filter((row) => row[1] === "@count"),
    ).toEqual([]);
  });

  it("writes what `@thing ||= build` puts there, which runs as a whole value", async () => {
    const source = "class C\n  def go\n    @thing ||= Entity.all\n  end\nend\n";
    const db = await factsFor(source);
    expect(
      rows(db, "holdsProperty")
        .filter((row) => row[1] === "@thing")
        .map((row) => row[2]),
    ).toEqual([keyOf(source, "Entity.all")]);
  });

  it("says nothing about an instance variable written outside any class", async () => {
    const db = await factsFor("@thing = Entity.all\n@thing\n");
    expect(db.size("holdsProperty")).toBe(0);
    expect(rows(db, "readsProperty").map((row) => row[2])).not.toContain(
      "@thing",
    );
  });

  it("settles nothing for a parameter the body writes again", async () => {
    const db = await factsFor("def act(scope)\n  scope = Entity.all\nend\n");
    expect(db.size("endsHolding")).toBe(0);
    expect(rows(db, "binds").map((row) => row[0])).toEqual(["#act"]);
  });

  it("keys a block parameter under the block rather than the file", async () => {
    const source = "rows.each do |row|\n  found = row\nend\n";
    const db = await factsFor(source);
    const block = keyOf(source, "do |row|\n  found = row\nend");
    expect(rows(db, "binds")).toContainEqual(["#found", `${block}#row`]);
  });

  it("reads the whole right side of an ||= as the value it writes", async () => {
    const source = "x ||= Foo.new\n";
    const db = await factsFor(source);
    expect(rows(db, "binds")).toEqual([["#x", keyOf(source, "Foo.new")]]);
  });

  it("settles nothing for a name only a += writes again", async () => {
    const db = await factsFor("count = 0\ncount += 1\n");
    expect(db.size("endsHolding")).toBe(0);
    expect(db.size("binds")).toBe(0);
  });

  it("binds nothing for a name a multiple assignment writes", async () => {
    const db = await factsFor("a, b = pair\n");
    expect(db.size("binds")).toBe(0);
  });

  it("records nothing for an operator assignment whose left side is not a plain name", async () => {
    const db = await factsFor("obj.count += 1\n");
    expect(db.size("binds")).toBe(0);
    expect(db.size("endsHolding")).toBe(0);
  });

  it("writes a for loop's variable with no value, and keeps it usable after the loop", async () => {
    const source = [
      "def act",
      "  for i in list",
      "  end",
      "  return i",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")).toContainEqual([funcKey, `${funcKey}#i`]);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#i`,
    );
  });

  it("does not resolve a block parameter's name to the block when read outside the block, in the method body", async () => {
    const source = [
      "def act",
      "  list.each do |item|",
      "  end",
      "  return item",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    expect(rows(db, "returnsValue").map((row) => row[1])).toContain("#item");
  });

  it("does not resolve a block parameter's name to the block when read outside any block, at the top of a file", async () => {
    const db = await factsFor(
      ["list.each do |item|", "end", "other = item", ""].join("\n"),
    );
    expect(rows(db, "binds")).toContainEqual(["#other", "#item"]);
  });

  it("does not mistake a method call for a read of a same-named local", async () => {
    const source = [
      "def act",
      "  where = Foo.new",
      "  query.where(x)",
      "  where = Bar.new",
      "end",
      "",
    ].join("\n");
    const db = await factsFor(source);
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([
      [`${funcKey}#where`, keyOf(source, "Bar.new")],
    ]);
  });
});
