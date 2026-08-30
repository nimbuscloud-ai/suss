import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parsePython } from "../parser.js";
import { emitValueFacts } from "./values.js";

async function factsFor(source: string) {
  const tree = await parsePython(source);
  const db = new Database();
  emitValueFacts(db, "f.py", tree.rootNode);
  return db;
}

/** The tuples of one relation, with the file prefix dropped so a test reads. */
function rows(db: Database, relation: string): string[][] {
  return db
    .facts(relation)
    .map((row) => row.map((value) => String(value).replace("f.py", "")));
}

describe("python value facts", () => {
  it("says a def is a function and binds its name to it", async () => {
    const db = await factsFor("def handler():\n    pass\n");
    expect(db.size("func")).toBe(1);
    expect(rows(db, "binds")[0]?.[0]).toBe("#handler");
  });

  it("gives each parameter its position, keyed under the function that declares it", async () => {
    const db = await factsFor("def handler(a, b, c):\n    pass\n");
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "paramOf").map((row) => [row[1], row[2]])).toEqual([
      ["0", `${funcKey}#a`],
      ["1", `${funcKey}#b`],
      ["2", `${funcKey}#c`],
    ]);
  });

  it("records what a function returns", async () => {
    const db = await factsFor("def handler():\n    return other\n");
    expect(rows(db, "returnsValue")[0]?.[1]).toBe("#other");
  });

  it("keeps a list's elements under their positions, the way an array does", async () => {
    const db = await factsFor("items = [first, second]\n");
    expect(db.size("objectValue")).toBe(1);
    expect(rows(db, "holdsProperty").map((row) => [row[1], row[2]])).toEqual([
      ["0", "#first"],
      ["1", "#second"],
    ]);
  });

  it("keeps a tuple's elements the same way", async () => {
    const db = await factsFor("pair = (first, second)\n");
    expect(rows(db, "holdsProperty").map((row) => row[1])).toEqual(["0", "1"]);
  });

  it("keeps a dictionary's values under their written keys", async () => {
    const db = await factsFor('config = {"host": host_name}\n');
    expect(rows(db, "holdsProperty").map((row) => [row[1], row[2]])).toEqual([
      ["host", "#host_name"],
    ]);
  });

  it("records a call, its callee and its arguments by position", async () => {
    const db = await factsFor("build(first, second)\n");
    expect(db.size("call")).toBe(1);
    expect(rows(db, "call")[0]?.[1]).toBe("#build");
    expect(rows(db, "callArg").map((row) => [row[1], row[2]])).toEqual([
      ["0", "#first"],
      ["1", "#second"],
    ]);
  });

  it("records a keyword argument under its name rather than a position", async () => {
    const db = await factsFor("build(prefix=value)\n");
    expect(db.size("callArg")).toBe(0);
    expect(rows(db, "callKeywordArg").map((row) => [row[1], row[2]])).toEqual([
      ["prefix", "#value"],
    ]);
  });

  it("reads an attribute as a property of its object", async () => {
    const db = await factsFor("value = config.host\n");
    expect(rows(db, "readsProperty")[0]?.slice(1)).toEqual(["#config", "host"]);
  });

  it("binds a name to what an assignment writes", async () => {
    const db = await factsFor("alias = original\n");
    expect(rows(db, "binds")).toEqual([["#alias", "#original"]]);
  });

  it("gives a nested def its own returns rather than the outer one's", async () => {
    const db = await factsFor(
      [
        "def outer():",
        "    def inner():",
        "        return deep",
        "    return shallow",
        "",
      ].join("\n"),
    );
    const returned = rows(db, "returnsValue").map((row) => row[1]);
    expect(returned).toContain("#deep");
    expect(returned).toContain("#shallow");
    expect(db.size("containsFn")).toBe(1);
  });
  it("records the calls a function's body makes", async () => {
    const db = await factsFor("def handler():\n    log(event)\n");
    expect(db.size("bodyCalls")).toBe(1);
  });

  it("skips a dictionary key that is not written as a string", async () => {
    const db = await factsFor("table = {key_name: value}\n");
    expect(db.size("holdsProperty")).toBe(0);
    expect(db.size("objectValue")).toBe(1);
  });

  it("says a literal is written out in the source", async () => {
    const db = await factsFor('name = "orders"\n');
    expect(db.size("writtenValue")).toBe(1);
  });

  it("binds nothing for an assignment whose left is not a plain name", async () => {
    const db = await factsFor("config[key] = value\n");
    expect(db.size("binds")).toBe(0);
  });

  it("treats a lambda as a function of its own", async () => {
    const db = await factsFor("pick = lambda item: item\n");
    expect(db.size("func")).toBe(1);
  });
  it("keys a parameter under its own function, so two functions can both take a loader", async () => {
    const db = await factsFor(
      [
        "def outer(loader):",
        "    return inner(loader=loader)",
        "",
        "def inner(loader):",
        "    return loader",
        "",
      ].join("\n"),
    );
    const params = rows(db, "paramOf").map((row) => row[2]);
    expect(new Set(params).size, "the two loaders collided").toBe(2);
  });

  it("reads a name inside a function as that function's parameter", async () => {
    const db = await factsFor(
      ["def handler(order):", "    return order", ""].join("\n"),
    );
    const [param] = rows(db, "paramOf");
    const [returned] = rows(db, "returnsValue");
    expect(returned?.[1]).toBe(param?.[2]);
  });

  it("reads a name that is not a parameter as the module's own", async () => {
    const db = await factsFor(
      ["def handler(order):", "    return registry", ""].join("\n"),
    );
    expect(rows(db, "returnsValue")[0]?.[1]).toBe("#registry");
  });

  it("passes the outer function's parameter as the argument, keyed to the outer one", async () => {
    const db = await factsFor(
      [
        "def outer(loader):",
        "    return inner(loader=loader)",
        "",
        "def inner(loader):",
        "    pass",
        "",
      ].join("\n"),
    );
    const outerParam = rows(db, "paramOf").find((row) =>
      row[2]?.includes("#loader"),
    );
    expect(rows(db, "callKeywordArg")[0]?.[2]).toBe(outerParam?.[2]);
  });
  it("makes a class an object containing its methods", async () => {
    const db = await factsFor(
      ["class Loader:", "    def load(self):", "        pass", ""].join("\n"),
    );
    const [cls] = rows(db, "objectValue");
    const [method] = rows(db, "func");
    expect(rows(db, "holdsProperty")).toEqual([
      [cls?.[0], "load", method?.[0]],
    ]);
  });

  it("keeps two classes' methods of one name apart", async () => {
    const db = await factsFor(
      [
        "class First:",
        "    def load(self):",
        "        pass",
        "",
        "class Second:",
        "    def load(self):",
        "        pass",
        "",
      ].join("\n"),
    );
    expect(
      rows(db, "binds")
        .map((row) => row[0] ?? "")
        .filter((key) => !key.endsWith("#self")),
    ).toEqual(["#First", "#Second"]);
    expect(rows(db, "exportsAs").map((row) => row[1])).toEqual([
      "First",
      "Second",
    ]);
  });

  it("binds a method's receiver to the class it is declared in", async () => {
    const db = await factsFor(
      ["class Holder:", "    def wire(self):", "        pass", ""].join("\n"),
    );
    const [cls] = rows(db, "objectValue");
    const [method] = rows(db, "func");
    expect(rows(db, "binds")).toContainEqual([`${method?.[0]}#self`, cls?.[0]]);
  });

  it("puts what a method writes to its receiver on the class", async () => {
    const db = await factsFor(
      [
        "class Holder:",
        "    def __init__(self):",
        "        self.app = build()",
        "",
      ].join("\n"),
    );
    const [cls] = rows(db, "objectValue");
    expect(rows(db, "holdsProperty").map((row) => [row[0], row[1]])).toEqual([
      [cls?.[0], "app"],
      [cls?.[0], "__init__"],
    ]);
  });

  it("binds a name a method's body assigns", async () => {
    const db = await factsFor(
      [
        "class Holder:",
        "    def build(self):",
        "        app = make()",
        "",
      ].join("\n"),
    );
    expect(rows(db, "binds").map((row) => row[0])).toContain("#app");
  });

  it("keeps a class attribute under its name", async () => {
    const db = await factsFor(
      ["class Loader:", "    registry = built", ""].join("\n"),
    );
    expect(rows(db, "holdsProperty")[0]?.slice(1)).toEqual([
      "registry",
      "#built",
    ]);
  });

  it("reaches a decorated method the same way", async () => {
    const db = await factsFor(
      [
        "class Loader:",
        "    @cached",
        "    def load(self):",
        "        pass",
        "",
      ].join("\n"),
    );
    expect(rows(db, "holdsProperty")[0]?.[1]).toBe("load");
  });
  it("reads the name of a parameter written with a type annotation", async () => {
    const db = await factsFor(
      "def build(loader: Loader, name: str):\n    pass\n",
    );
    expect(rows(db, "paramNamed").map((row) => row[1])).toEqual([
      "loader",
      "name",
    ]);
    expect(rows(db, "paramOf").map((row) => row[1])).toEqual(["0", "1"]);
  });

  it("skips a method's receiver, which the caller does not write", async () => {
    const db = await factsFor(
      ["class Loader:", "    def load(self, key):", "        pass", ""].join(
        "\n",
      ),
    );
    expect(rows(db, "paramOf").map((row) => [row[1], row[2]])).toEqual([
      ["0", rows(db, "func")[0]?.[0] + "#key"],
    ]);
    expect(rows(db, "paramNamed").map((row) => row[1])).toEqual([
      "self",
      "key",
    ]);
  });

  it("gives a parameter after a splat a name but no position", async () => {
    const db = await factsFor("def build(a, *rest, flag=False):\n    pass\n");
    expect(rows(db, "paramOf").map((row) => row[1])).toEqual(["0"]);
    expect(rows(db, "paramNamed").map((row) => row[1])).toEqual(["a", "flag"]);
  });
});
