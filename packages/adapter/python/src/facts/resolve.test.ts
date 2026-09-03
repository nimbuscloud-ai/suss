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
  containedValues,
  objectReturnedBy,
  resolveCalls,
  subjectConstructions,
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

    // Seeds and evaluates the shared rules; read the relation directly,
    // apart from the single-answer map subjectConstructions builds on it.
    subjectConstructions(facts, [String(outerCall?.[0])]);
    const written = facts
      .facts("wantedSubjectWritten")
      .filter((row) => row[0] === outerCall?.[0])
      .map((row) => String(row[1]));
    expect(written).toContain(String(innerCall?.[0]));
  });
});
