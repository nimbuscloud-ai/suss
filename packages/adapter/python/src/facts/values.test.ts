import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { children } from "../ast.js";
import { parsePython } from "../parser.js";
import { emitValueFacts, parameterList, parameterShapes } from "./values.js";

import type { PyNode } from "../parser.js";

async function factsFor(source: string) {
  const tree = await parsePython(source);
  const db = new Database();
  emitValueFacts(db, "f.py", tree.rootNode);
  return db;
}

/** The first def in a tree, for a test that wants the node rather than the facts it emits. */
function findFunctionNode(node: PyNode): PyNode | null {
  if (node.type === "function_definition") {
    return node;
  }
  for (const child of children(node)) {
    const found = findFunctionNode(child);
    if (found !== null) {
      return found;
    }
  }
  return null;
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

  it("records the class a return annotation names, and the name as written", async () => {
    const db = await factsFor("def current_user() -> User: ...\n");
    expect(rows(db, "returnsClass").map((row) => row[1])).toEqual(["#User"]);
    expect(rows(db, "returnsNamed").map((row) => row[1])).toEqual(["User"]);
  });

  it("reads Optional and Awaitable through to the class inside them", async () => {
    const optional = await factsFor("def find() -> Optional[User]: ...\n");
    expect(rows(optional, "returnsClass").map((row) => row[1])).toEqual([
      "#User",
    ]);
    const awaited = await factsFor(
      "async def load() -> Awaitable[User]: ...\n",
    );
    expect(rows(awaited, "returnsClass").map((row) => row[1])).toEqual([
      "#User",
    ]);
    const orNone = await factsFor("def find() -> User | None: ...\n");
    expect(rows(orNone, "returnsClass").map((row) => row[1])).toEqual([
      "#User",
    ]);
  });

  it("says nothing about a generic that hands back a container", async () => {
    const db = await factsFor("def all_users() -> list[User]: ...\n");
    expect(db.size("returnsClass")).toBe(0);
    expect(db.size("returnsNamed")).toBe(0);
  });

  it("leaves the annotation alone when the body states what it returns", async () => {
    const db = await factsFor(
      "def current_user() -> User:\n    return cached\n",
    );
    expect(rows(db, "returnsValue").map((row) => row[1])).toEqual(["#cached"]);
    expect(db.size("returnsClass")).toBe(0);
    expect(db.size("returnsNamed")).toBe(0);
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

  it("keys a name a method's body assigns under that method", async () => {
    const db = await factsFor(
      [
        "class Holder:",
        "    def build(self):",
        "        app = make()",
        "",
      ].join("\n"),
    );
    const [method] = rows(db, "func")[0] ?? [];
    expect(rows(db, "binds").map((row) => row[0])).toContain(`${method}#app`);
  });

  it("says the name a base class is written as, so a pack can match on it", async () => {
    const db = await factsFor(
      ["class Item(SQLModel, table=True):", "    pass", ""].join("\n"),
    );
    expect(rows(db, "extendsNamed").map((row) => row[1])).toEqual(["SQLModel"]);
  });

  it("says the dotted name too, and nothing for a subscript", async () => {
    const db = await factsFor(
      ["class Item(db.Model, Generic[T]):", "    pass", ""].join("\n"),
    );
    expect(rows(db, "extendsNamed").map((row) => row[1])).toEqual(["db.Model"]);
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

  it("leaves a tuple assignment alone, since neither name holds the pair", async () => {
    const db = await factsFor("a, b = build()\n");
    expect(rows(db, "binds")).toEqual([]);
  });

  it("puts a value on the class only when a method writes it to its own receiver", async () => {
    const db = await factsFor(
      [
        "class Holder:",
        "    def __init__(self, other):",
        "        self.app = build()",
        "        other.app = build()",
        "",
      ].join("\n"),
    );
    // The class keeps its own methods too, so the point is that one
    // write landed and the write to somebody else's receiver did not.
    const held = rows(db, "holdsProperty").map((row) => String(row[1]));
    expect(held.filter((name) => name === "app")).toEqual(["app"]);
  });

  it("says nothing about a subscript assignment", async () => {
    const db = await factsFor("registry['app'] = build()\n");
    expect(rows(db, "binds")).toEqual([]);
    expect(rows(db, "holdsProperty")).toEqual([]);
  });

  it("says nothing about an annotation that assigns no value", async () => {
    const db = await factsFor("app: FastAPI\n");
    expect(rows(db, "binds")).toEqual([]);
    expect(rows(db, "exportsAs")).toEqual([]);
  });

  it("takes a lambda that declares no parameter as a function all the same", async () => {
    const db = await factsFor("build = lambda: 1\n");
    expect(db.size("func")).toBe(1);
    expect(rows(db, "paramNamed")).toEqual([]);
  });

  it("gives no key to the marker that ends the positional parameters", async () => {
    const db = await factsFor("def build(a, *, flag=False):\n    pass\n");
    expect(rows(db, "paramNamed").map((row) => row[1])).toEqual(["a", "flag"]);
  });

  it("keys a name two functions both write under each of them", async () => {
    const db = await factsFor(
      [
        "def first():",
        "    query = build()",
        "",
        "def second():",
        "    query = build()",
        "",
      ].join("\n"),
    );
    const keys = rows(db, "binds")
      .map((row) => String(row[0]))
      .filter((key) => key.endsWith("#query"));
    expect(new Set(keys).size, "the two queries collided").toBe(2);
  });

  it("binds a name a function writes once to what it writes", async () => {
    const db = await factsFor(
      ["def handler():", "    query = build()", ""].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [call] = rows(db, "call")[0] ?? [];
    expect(rows(db, "binds")).toContainEqual([`${funcKey}#query`, call]);
  });

  it("leaves a function's own name out of what the module exports", async () => {
    const db = await factsFor(
      ["def build():", "    registry = make()", ""].join("\n"),
    );
    expect(rows(db, "exportsAs").map((row) => row[1])).toEqual(["build"]);
  });

  it("ends a name written as None and then as a call holding the call", async () => {
    const db = await factsFor(
      [
        "def handler(flag):",
        "    client = None",
        "    if flag:",
        "        client = Client()",
        "    return client",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [call] = rows(db, "call")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#client`, call]]);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#client`,
    );
  });

  it("ends a name written twice in a row holding the second write", async () => {
    const db = await factsFor(
      [
        "def handler(session):",
        "    query = session.query(Entity)",
        "    query = build(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [second] = rows(db, "call")[1] ?? [];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#query`, second]]);
  });

  it("ends a name a second write only narrows holding what the first write built", async () => {
    const db = await factsFor(
      [
        "def handler(session):",
        "    query = session.query(Entity)",
        "    query = query.filter(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [first] = rows(db, "call")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#query`, first]]);
  });

  it("reads a narrowing write through the parentheses around it", async () => {
    const db = await factsFor(
      [
        "def handler(session):",
        "    query = session.query(Entity)",
        "    query = (query).filter(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [first] = rows(db, "call")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#query`, first]]);
  });

  it("takes a write whose chain starts at an element rather than the name as a fresh value", async () => {
    const db = await factsFor(
      [
        "def handler(session):",
        "    query = session.query(Entity)",
        "    query = query[0].filter(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const second = rows(db, "call")[1]?.[0];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#query`, second]]);
  });

  it("says nothing about a name whose second write is behind a branch", async () => {
    const db = await factsFor(
      [
        "def handler(flag):",
        "    q = Entity.query",
        "    if flag:",
        "        q = q.filter(1)",
        "    return q",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([]);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#q`,
    );
  });

  it("names each write to such a name, and says it read all of them", async () => {
    const db = await factsFor(
      [
        "def handler(flag):",
        "    q = Entity.query",
        "    if flag:",
        "        q = Other.query",
        "    return q",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "mayHold").map((row) => row[0])).toEqual([
      `${funcKey}#q`,
      `${funcKey}#q`,
    ]);
    expect(rows(db, "writesAllStated")).toEqual([[`${funcKey}#q`]]);
  });

  it("says nothing about reading all of them when one write states no value", async () => {
    const db = await factsFor(
      [
        "def handler(flag, items):",
        "    for q in items:",
        "        pass",
        "    if flag:",
        "        q = Other.query",
        "    return q",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "writesUnstated")).toEqual([[`${funcKey}#q`]]);
    expect(db.size("mayHold")).toBe(1);
    expect(db.size("writesAllStated")).toBe(0);
  });

  it("says nothing about reading all of them for a parameter a branch writes again", async () => {
    const db = await factsFor(
      [
        "def handler(thing, flag):",
        "    if flag:",
        "        thing = Entity()",
        "    return thing",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "mayHold").map((row) => row[0])).toEqual([
      `${funcKey}#thing`,
    ]);
    expect(db.size("writesUnstated")).toBe(0);
    expect(db.size("writesAllStated")).toBe(0);
  });

  it("says nothing about a parameter the body writes again", async () => {
    const db = await factsFor(
      ["def handler(db):", "    db = connect()", "    return db", ""].join(
        "\n",
      ),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "endsHolding")).toEqual([]);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#db`,
    );
  });

  it("makes a loop target the function's own name with no value settled", async () => {
    const db = await factsFor(
      [
        "def handler(items):",
        "    for item in items:",
        "        pass",
        "    return item",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${funcKey}#item`);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#item`,
    );
  });

  it("reads a name a nested def only reads as the outer function's", async () => {
    const db = await factsFor(
      [
        "def outer():",
        "    query = build()",
        "    def inner():",
        "        return query",
        "    return inner",
        "",
      ].join("\n"),
    );
    const [outerKey] = rows(db, "func")[0] ?? [];
    const returned = rows(db, "returnsValue").map((row) => row[1]);
    expect(returned).toContain(`${outerKey}#query`);
  });

  it("writes a name a function declares global under the module", async () => {
    const db = await factsFor(
      [
        "counter = 0",
        "",
        "def bump():",
        "    global counter",
        "    counter = 1",
        "",
      ].join("\n"),
    );
    const keys = rows(db, "binds").map((row) => String(row[0]));
    expect(keys.filter((key) => key.endsWith("#counter"))).toEqual([
      "#counter",
      "#counter",
    ]);
  });

  it("lists a function's parameters by name, leaving a splat and a bare separator out", async () => {
    const tree = await parsePython(
      "def build(a, /, *args, flag=False):\n    pass\n",
    );
    const fn = findFunctionNode(tree.rootNode);
    if (fn === null) {
      throw new Error("expected a function_definition node");
    }
    expect(parameterList(fn)).toEqual(["a", "flag"]);
  });

  it("pairs a parameter with the default it declares", async () => {
    const tree = await parsePython("def build(a, flag=False):\n    pass\n");
    const fn = findFunctionNode(tree.rootNode);
    if (fn === null) {
      throw new Error("expected a function_definition node");
    }
    const shapes = parameterShapes(fn);
    expect(shapes.map((parameter) => parameter.name)).toEqual(["a", "flag"]);
    expect(shapes[0]?.default).toBeNull();
    expect(shapes[1]?.default?.text).toBe("False");
  });

  it("keeps the position of a keyword-only parameter past a bare *", async () => {
    const tree = await parsePython("def route(a, *, b):\n    pass\n");
    const fn = findFunctionNode(tree.rootNode);
    if (fn === null) {
      throw new Error("expected a function_definition node");
    }
    expect(
      parameterShapes(fn).map((parameter) => ({
        name: parameter.name,
        position: parameter.position,
      })),
    ).toEqual([
      { name: "a", position: 0 },
      { name: "b", position: 1 },
    ]);
  });

  it("skips a dictionary child written as a spread rather than a pair", async () => {
    const db = await factsFor("config = {**other}\n");
    expect(db.size("holdsProperty")).toBe(0);
    expect(db.size("objectValue")).toBe(1);
  });

  it("binds nothing for an augmented assignment whose left is not a plain name", async () => {
    const db = await factsFor("counts[0] += 1\n");
    expect(db.size("binds")).toBe(0);
  });

  it("says nothing about a name a += statement reassigns, since it states no value of its own", async () => {
    const db = await factsFor(
      [
        "def handler():",
        "    count = 0",
        "    count += 1",
        "    return count",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${funcKey}#count`);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#count`,
    );
    expect(rows(db, "endsHolding").map((row) => row[0])).not.toContain(
      `${funcKey}#count`,
    );
  });

  it("sends a name a nested function declares nonlocal to the enclosing function", async () => {
    const db = await factsFor(
      [
        "def outer():",
        "    total = 0",
        "    def inner():",
        "        nonlocal total",
        "        total = 1",
        "    inner()",
        "    return total",
        "",
      ].join("\n"),
    );
    const [outerKey] = rows(db, "func")[0] ?? [];
    const keys = rows(db, "binds").map((row) => row[0]);
    expect(keys.filter((key) => key === `${outerKey}#total`)).toHaveLength(2);
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${outerKey}#total`);
  });

  it("makes a with-target the function's own name with no value settled", async () => {
    const db = await factsFor(
      [
        "def handler():",
        "    with open('config') as fh:",
        "        return fh",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${funcKey}#fh`);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#fh`,
    );
  });

  it("says which call a with-target entered, instead of that it states nothing", async () => {
    const db = await factsFor(
      [
        "def handler():",
        "    with httpx.Client() as client:",
        "        return client",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const [callKey] = rows(db, "call")[0] ?? [];
    expect(rows(db, "entersAs")).toEqual([[`${funcKey}#client`, callKey]]);
    expect(rows(db, "writesUnstated")).toEqual([]);
  });

  it("says a with-target states nothing when it is not opened over a call", async () => {
    const db = await factsFor(
      [
        "def handler(source):",
        "    with source as reader:",
        "        return reader",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "entersAs")).toEqual([]);
    expect(rows(db, "writesUnstated")).toEqual([[`${funcKey}#reader`]]);
  });

  it("makes an except-target the function's own name with no value settled", async () => {
    const db = await factsFor(
      [
        "def handler():",
        "    try:",
        "        pass",
        "    except Exception as err:",
        "        return err",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${funcKey}#err`);
    expect(rows(db, "binds").map((row) => row[0])).not.toContain(
      `${funcKey}#err`,
    );
  });

  it("binds a match-case alias the same way an as-pattern does elsewhere", async () => {
    const db = await factsFor(
      [
        "def handler(x):",
        "    match x:",
        "        case str() as s:",
        "            return s",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    expect(rows(db, "returnsValue")[0]?.[1]).toBe(`${funcKey}#s`);
  });

  it("does not count a nested def's own read as a read before the outer write", async () => {
    const db = await factsFor(
      [
        "def outer():",
        "    query = build()",
        "    def inner():",
        "        return query",
        "    query = rebuild(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [outerKey] = rows(db, "func")[0] ?? [];
    const secondCall = rows(db, "call")[1]?.[0];
    expect(rows(db, "endsHolding")).toEqual([
      [`${outerKey}#query`, secondCall],
    ]);
  });

  it("does not count a name inside a nested class body as a read before the outer write", async () => {
    const db = await factsFor(
      [
        "def outer():",
        "    query = build()",
        "    class Inner:",
        "        query = 1",
        "    query = rebuild(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [outerKey] = rows(db, "func")[0] ?? [];
    const secondCall = rows(db, "call")[1]?.[0];
    expect(rows(db, "endsHolding")).toEqual([
      [`${outerKey}#query`, secondCall],
    ]);
  });

  it("does not count a name mentioned in an import path as a read before a later write", async () => {
    const db = await factsFor(
      [
        "def handler(session):",
        "    query = session.query(Entity)",
        "    import query.sub",
        "    query = rebuild(1)",
        "    return query",
        "",
      ].join("\n"),
    );
    const [funcKey] = rows(db, "func")[0] ?? [];
    const secondCall = rows(db, "call")[1]?.[0];
    expect(rows(db, "endsHolding")).toEqual([[`${funcKey}#query`, secondCall]]);
  });

  it("records nothing for a with-target that unpacks rather than naming one thing", async () => {
    const db = await factsFor("with build() as (first, second):\n    pass\n");
    expect(db.size("binds")).toBe(0);
  });
});
