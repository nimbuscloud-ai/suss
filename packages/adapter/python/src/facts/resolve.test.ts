import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "../index.js";
import { containedValues, objectReturnedBy } from "./resolve.js";

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

async function factsFor(files: Record<string, string>) {
  const dir = project(files);
  const { facts } = await extractPythonProject({
    files: findPythonFiles(dir),
    packs: [],
    roots: [dir],
    workspaceRoot: dir,
  });
  return { facts, dir };
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
    expect(objectReturnedBy(facts, String(call?.[0]))).toBeNull();
  });
});
