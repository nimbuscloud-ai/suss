import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitModuleImportFacts } from "../facts.js";
import { findPythonFiles } from "../index.js";
import { parsePython } from "../parser.js";
import { bindModule } from "../scope.js";
import {
  constructionSites,
  containedValues,
  objectReturnedBy,
  resolveCalls,
  resolvedFunctions,
  subjectConstructions,
  writtenValueUnder,
} from "./resolve.js";
import { emitValueFacts } from "./values.js";

/** A project on disk, since resolution is about how files reach each other. */
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  return dir;
}

/**
 * The facts a reader that wants to follow a value builds for itself, which is
 * what the router index will do when it enumerates a loop over a call.
 */
async function factsFor(files: Record<string, string>) {
  const dir = project(files);
  const db = new Database();
  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    emitModuleImportFacts(db, file, bindModule(tree.rootNode), {
      roots: [dir],
    });
    emitValueFacts(db, file, tree.rootNode);
  }
  return { facts: db, dir };
}

/** `connect` from the project's `lib.py`, under the file and under the module as written. */
function connectFromLib(dir: string) {
  return [
    { module: path.join(dir, "lib.py"), name: "connect" },
    { module: "lib", name: "connect" },
  ];
}

describe("resolving a value across files", () => {
  it("follows a call into the list the function in another file returns", async () => {
    const { facts, dir } = await factsFor({
      "loader.py": [
        "from endpoint.orders import ns as orders_ns",
        "",
        "def all_namespaces():",
        "    return [orders_ns]",
        "",
      ].join("\n"),
      "endpoint/__init__.py": "",
      "endpoint/orders.py": "ns = 1\n",
      "app.py": [
        "from loader import all_namespaces",
        "",
        "registry = all_namespaces()",
        "",
      ].join("\n"),
    });

    const call = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#all_namespaces"));
    expect(call, "the call was not recorded").toBeDefined();

    resolveCalls(facts, [String(call?.[0])]);
    const returned = objectReturnedBy(facts, String(call?.[0]));
    expect(returned, "the call did not resolve to an object").not.toBeNull();
    expect(containedValues(facts, returned as string)).toEqual([
      `${path.join(dir, "loader.py")}#orders_ns`,
    ]);
  });

  it("keeps the local name when an import renames what it brings in", async () => {
    const { facts, dir } = await factsFor({
      "source.py": "value = 1\n",
      "app.py": "from source import value as renamed\n",
    });
    expect(facts.facts("imports").map((row) => row.map(String))).toEqual([
      [
        `${path.join(dir, "app.py")}#renamed`,
        path.join(dir, "source.py"),
        "value",
      ],
      [`${path.join(dir, "app.py")}#renamed`, "source", "value"],
    ]);
  });

  it("says what a module exports under each name", async () => {
    const { facts, dir } = await factsFor({
      "source.py": "def build():\n    pass\n\nalias = build\n",
    });
    const names = facts
      .facts("exportsAs")
      .filter((row) => row[0] === path.join(dir, "source.py"))
      .map((row) => String(row[1]))
      .sort();
    expect(names).toEqual(["alias", "build"]);
  });

  it("reads a method off the result of a function annotated with a class in another file", async () => {
    const { facts } = await factsFor({
      "models.py": [
        "class User:",
        "    def save(self):",
        "        pass",
        "",
      ].join("\n"),
      "app.py": [
        "from models import User",
        "",
        "def current_user() -> User: ...",
        "",
        "u = current_user()",
        "u.save()",
        "",
      ].join("\n"),
    });

    const read = facts
      .facts("readsProperty")
      .find((row) => String(row[2]) === "save");
    expect(read, "the method read was not recorded").toBeDefined();
    const method = facts
      .facts("holdsProperty")
      .find((row) => String(row[1]) === "save")?.[2];

    resolveCalls(facts, [String(read?.[0])]);
    expect(
      facts
        .facts("wantedResolves")
        .filter((row) => String(row[0]) === String(read?.[0]))
        .map((row) => String(row[1])),
    ).toEqual([String(method)]);
  });

  it("settles a method a subclass overrides on the subclass's own", async () => {
    const { facts } = await factsFor({
      "users.py": [
        "class Repository:",
        "    def save(self):",
        '        return "base"',
        "",
        "class Accounts(Repository):",
        "    def save(self):",
        '        return "accounts"',
        "",
        "def load():",
        "    accounts = Accounts()",
        "    return accounts.save()",
        "",
      ].join("\n"),
    });

    const read = String(
      facts
        .facts("readsProperty")
        .find((row) => String(row[2]) === "save")?.[0],
    );
    const startOf = (key: string): number =>
      Number(key.slice(key.lastIndexOf(":") + 1).split("-")[0]);
    const [baseSave, ownSave] = facts
      .facts("holdsProperty")
      .filter((row) => String(row[1]) === "save")
      .map((row) => String(row[2]))
      .sort((left, right) => startOf(left) - startOf(right));
    resolveCalls(facts, [read]);
    expect(resolvedFunctions(facts, read)).toEqual([ownSave]);
    expect(baseSave).not.toBe(ownSave);
  });

  it("keeps both methods for a receiver that can be the base or the subclass", async () => {
    const { facts } = await factsFor({
      "users.py": [
        "class Repository:",
        "    def save(self):",
        '        return "base"',
        "",
        "class Accounts(Repository):",
        "    def save(self):",
        '        return "accounts"',
        "",
        "def persist(repository):",
        "    return repository.save()",
        "",
        "persist(Accounts())",
        "persist(Repository())",
        "",
      ].join("\n"),
    });

    const read = String(
      facts
        .facts("readsProperty")
        .find((row) => String(row[2]) === "save")?.[0],
    );
    resolveCalls(facts, [read]);
    expect(resolvedFunctions(facts, read)).toHaveLength(2);
  });

  it("claims nothing for a call whose callee it never reached", async () => {
    const { facts } = await factsFor({ "app.py": "registry = missing()\n" });
    const call = facts.facts("call")[0];
    resolveCalls(facts, [String(call?.[0])]);
    expect(objectReturnedBy(facts, String(call?.[0]))).toBeNull();
  });
  it("derives nothing when nobody asked about a call", async () => {
    const { facts } = await factsFor({ "app.py": "registry = build()\n" });
    const before = facts.size("wantedObjectOf");
    resolveCalls(facts, []);
    expect(facts.size("wantedObjectOf")).toBe(before);
  });

  it("reads a returned list back in the order the source writes it", async () => {
    const { facts, dir } = await factsFor({
      "loader.py": [
        "def all_types():",
        "    return [first, second, third]",
        "",
      ].join("\n"),
      "app.py": [
        "from loader import all_types",
        "",
        "registry = all_types()",
        "",
      ].join("\n"),
    });
    const call = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#all_types"));
    resolveCalls(facts, [String(call?.[0])]);
    const returned = objectReturnedBy(facts, String(call?.[0]));
    expect(containedValues(facts, returned as string)).toEqual([
      `${path.join(dir, "loader.py")}#first`,
      `${path.join(dir, "loader.py")}#second`,
      `${path.join(dir, "loader.py")}#third`,
    ]);
  });

  it("derives a call reached through a wrapper as written by the construction it returns", async () => {
    const { facts } = await factsFor({
      "lib.py": "class Client:\n    pass\n",
      "client.py": [
        "from lib import Client",
        "",
        "def make_client():",
        "    return Client()",
        "",
      ].join("\n"),
      "app.py": [
        "from client import make_client",
        "",
        "make_client().send()",
        "",
      ].join("\n"),
    });

    const outerCall = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#make_client"));
    expect(outerCall, "the wrapper call was not recorded").toBeDefined();
    const innerCall = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#Client"));
    expect(innerCall, "the construction was not recorded").toBeDefined();

    // The relation itself, since subjectConstructions folds it into one
    // answer or none.
    subjectConstructions(facts, [String(outerCall?.[0])]);
    const written = facts
      .facts("wantedSubjectWritten")
      .filter((row) => row[0] === outerCall?.[0])
      .map((row) => String(row[1]));
    expect(written).toContain(String(innerCall?.[0]));
  });

  it("settles a name bound to a wrapper call on the construction the wrapper returns", async () => {
    const { facts, dir } = await factsFor({
      "lib.py": "def connect():\n    pass\n",
      "client.py": [
        "from lib import connect",
        "",
        "def make_client():",
        "    return connect()",
        "",
      ].join("\n"),
      "app.py": [
        "from client import make_client",
        "",
        "router = make_client()",
        "",
      ].join("\n"),
    });

    const construction = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    const nameKey = `${path.join(dir, "app.py")}#router`;
    const settled = subjectConstructions(facts, [nameKey]);
    expect(settled.get(nameKey)).toEqual({
      constructionKey: String(construction?.[0]),
      origins: connectFromLib(dir),
    });
  });

  it("settles a name built by a member of a plain module import", async () => {
    const { facts, dir } = await factsFor({
      "app.py": ["import fastapi", "", "router = fastapi.APIRouter()", ""].join(
        "\n",
      ),
    });

    const construction = facts.facts("call")[0];
    expect(construction, "the construction was not recorded").toBeDefined();

    const nameKey = `${path.join(dir, "app.py")}#router`;
    const settled = subjectConstructions(facts, [nameKey]);
    expect(settled.get(nameKey)).toEqual({
      constructionKey: String(construction?.[0]),
      origins: [{ module: "fastapi", name: "APIRouter" }],
    });
  });

  it("settles a call to a wrapper on the construction the wrapper returns", async () => {
    const { facts, dir } = await factsFor({
      "lib.py": "def connect():\n    pass\n",
      "client.py": [
        "from lib import connect",
        "",
        "def make_client():",
        "    return connect()",
        "",
      ].join("\n"),
      "app.py": [
        "from client import make_client",
        "",
        "make_client().send()",
        "",
      ].join("\n"),
    });

    const wrapperCall = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#make_client"));
    expect(wrapperCall, "the wrapper call was not recorded").toBeDefined();
    const construction = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    const settled = subjectConstructions(facts, [String(wrapperCall?.[0])]);
    expect(settled.get(String(wrapperCall?.[0]))).toEqual({
      constructionKey: String(construction?.[0]),
      origins: connectFromLib(dir),
    });
  });

  it("settles a name written as None and then as a construction behind a guard", async () => {
    const { facts, dir } = await factsFor({
      "lib.py": "def connect():\n    pass\n",
      "client.py": [
        "from lib import connect",
        "",
        "_client = None",
        "",
        "def client():",
        "    global _client",
        "    if _client is None:",
        "        _client = connect()",
        "    return _client",
        "",
      ].join("\n"),
    });

    const construction = facts
      .facts("call")
      .find((row) => String(row[1]).endsWith("#connect"));
    expect(construction, "the construction was not recorded").toBeDefined();

    const nameKey = `${path.join(dir, "client.py")}#_client`;
    const settled = subjectConstructions(facts, [nameKey]);
    expect(settled.get(nameKey)).toEqual({
      constructionKey: String(construction?.[0]),
      origins: connectFromLib(dir),
    });
  });

  it("declines a name written as None and then as two different constructions", async () => {
    const { facts, dir } = await factsFor({
      "lib.py": "def connect():\n    pass\n\ndef attach():\n    pass\n",
      "client.py": [
        "from lib import connect, attach",
        "",
        "_client = None",
        "",
        "def client(local):",
        "    global _client",
        "    if local:",
        "        _client = attach()",
        "    else:",
        "        _client = connect()",
        "    return _client",
        "",
      ].join("\n"),
    });

    const nameKey = `${path.join(dir, "client.py")}#_client`;
    expect(subjectConstructions(facts, [nameKey]).has(nameKey)).toBe(false);
  });
});

describe("reading a value under one construction", () => {
  const RESOURCE = [
    "class Resource:",
    "    def __init__(self, base):",
    "        self.base = base",
    "",
    "    def list(self):",
    "        return self.base",
    "",
  ];

  /** The attribute read in `list`, keyed the way the facts key it. */
  function readInList(db: Database): string {
    const row = db
      .facts("readsProperty")
      .find((one) => String(one[2]) === "base");
    if (row === undefined) {
      throw new Error("the attribute read was not emitted");
    }
    return String(row[0]);
  }

  function classKeyOf(db: Database): string {
    const row = db.facts("objectValue")[0];
    if (row === undefined) {
      throw new Error("the class was not emitted");
    }
    return String(row[0]);
  }

  it("gives each construction its own literal", async () => {
    const { facts } = await factsFor({
      "app.py": [
        ...RESOURCE,
        'users = Resource("/users")',
        'orders = Resource("/orders")',
      ].join("\n"),
    });
    const read = readInList(facts);

    const written = constructionSites(facts, classKeyOf(facts))
      .map((site) => writtenValueUnder(facts, read, site))
      .map((answer) => (answer === null ? "nothing" : answer));
    expect(written).toHaveLength(2);
    expect(new Set(written).size).toBe(2);
    expect(written).not.toContain("nothing");
  });

  it("gives nothing for an attribute the constructor writes twice", async () => {
    const { facts } = await factsFor({
      "app.py": [
        "class Resource:",
        "    def __init__(self, flag):",
        "        if flag:",
        '            self.base = "/users"',
        "        else:",
        '            self.base = "/orders"',
        "",
        "    def list(self):",
        "        return self.base",
        "",
        "users = Resource(True)",
      ].join("\n"),
    });
    const read = readInList(facts);

    const sites = constructionSites(facts, classKeyOf(facts));
    expect(sites).toHaveLength(1);
    expect(writtenValueUnder(facts, read, sites[0] as string)).toBe(null);
  });

  it("reads an attribute written as a fallback as the fallback, as a read with no site does", async () => {
    const source = [
      "import os",
      "",
      "class Resource:",
      "    def __init__(self, base):",
      '        self.base = base or "/api"',
      "",
      "    def list(self):",
      "        return self.base",
      "",
      'users = Resource(os.environ.get("USERS_BASE"))',
    ].join("\n");
    const { facts, dir } = await factsFor({ "app.py": source });
    const read = readInList(facts);
    const start = source.indexOf('base or "/api"');
    const fallback = `${path.join(dir, "app.py")}:${start}-${start + 'base or "/api"'.length}`;

    const sites = constructionSites(facts, classKeyOf(facts));
    expect(sites).toHaveLength(1);
    expect(writtenValueUnder(facts, read, sites[0] as string)).toBe(fallback);
  });

  it("does not find a construction for a class nothing builds", async () => {
    const { facts } = await factsFor({ "app.py": RESOURCE.join("\n") });

    expect(constructionSites(facts, classKeyOf(facts))).toEqual([]);
  });
});
