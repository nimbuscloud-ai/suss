import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { type CaseFiles, checkFactContract } from "@suss/resolution";

import { emitModuleImportFacts } from "../facts.js";
import { parsePython } from "../parser.js";
import { findPythonFiles } from "../project.js";
import { bindModule } from "../scope.js";
import { emitValueFacts } from "./values.js";

/** Python's own spelling of each case the contract states. */
const SOURCES: Record<string, CaseFiles> = {
  "two functions, one parameter name": {
    "f.py": [
      "def outer(loader):",
      "    pass",
      "",
      "def inner(loader):",
      "    pass",
      "",
    ].join("\n"),
  },
  "a name read inside a function": {
    "f.py": ["def handler(order):", "    return order", ""].join("\n"),
  },
  "a function calling its parameter": {
    "f.py": ["def guard(fn):", "    fn(1)", ""].join("\n"),
  },
  "a name bound to a call": { "f.py": "registry = build()\n" },
  "a written-out sequence": { "f.py": "items = [first, second]\n" },
  "a module exporting a name": { "f.py": "def build():\n    pass\n" },
  "a class declaring a method": {
    "f.py": ["class Loader:", "    def load(self):", "        pass", ""].join(
      "\n",
    ),
  },
  "a class constructed with an argument": {
    "f.py": [
      "class Loader:",
      "    def __init__(self, source):",
      "        self.source = source",
      "",
      "loader = Loader(source)",
      "",
    ].join("\n"),
  },
  "a name declared as a fallback": {
    "f.py": "client = cached or build()\n",
  },
  "a property written through a name": {
    "f.py": [
      "class ReportJob:",
      "    pass",
      "",
      "job = ReportJob()",
      "job.retries = 3",
      "",
    ].join("\n"),
  },
  "a class extending another": {
    "f.py": [
      "class User:",
      "    def save(self):",
      "        pass",
      "",
      "class Admin(User):",
      "    pass",
      "",
    ].join("\n"),
  },
  "a value another file declares": {
    "source.py": "value = 1\n",
    "f.py": "from source import value as renamed\n",
  },
  "a table of functions called by a key worked out at run time": {
    "f.py": [
      'TABLE = {"created": on_created, "deleted": on_deleted}',
      "",
      "def dispatch(kind, payload):",
      "    return TABLE[kind](payload)",
      "",
    ].join("\n"),
  },
  "a function written into a table under a computed key": {
    "f.py": [
      "REGISTRY = {}",
      "",
      "def register(name, handler):",
      "    REGISTRY[name] = handler",
      "",
    ].join("\n"),
  },
  "a list written with a spread": { "f.py": "items = [first, *rest]\n" },
  "an object written with a spread": {
    "f.py": 'options = {"a": first, **rest}\n',
  },
  "a template string with a hole": {
    "f.py": 'user_id = lookup()\npath = f"/users/{user_id}/posts"\n',
  },
  "a callback given each element of a list": {
    "f.py": "def names(users):\n    return [user for user in users]\n",
  },
  "a callback given the parts of each element of a list": {
    "f.py": "def names(pairs):\n    return [name for name, kind in pairs]\n",
  },
  "a callback given each position in a list": {
    "f.py":
      "def positions(users):\n    return [at for at, user in enumerate(users)]\n",
  },
  "a call made on what another call returns": {
    "f.py": "query = build().where(first)\n",
  },
  "a function comparing its two parameters": {
    "f.py": "def same(left, right):\n    return left == right\n",
  },
};

/**
 * Construction is the case Python does not key yet: `__init__` gets the
 * parameters, so an argument passed to `Loader(...)` lands nowhere.
 */
const KNOWN_GAPS: Record<string, string> = {
  "a class constructed with an argument":
    "the parameters are keyed on __init__ rather than on the class",
};

describe("the Python adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(
      SOURCES,
      async (files) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-"));
        for (const [name, source] of Object.entries(files)) {
          fs.writeFileSync(path.join(dir, name), source);
        }
        const db = new Database();
        for (const file of findPythonFiles(dir)) {
          const tree = await parsePython(fs.readFileSync(file, "utf8"));
          emitModuleImportFacts(db, file, bindModule(tree.rootNode), {
            roots: [dir],
          });
          emitValueFacts(db, file, tree.rootNode);
        }
        return db;
      },
      { known: KNOWN_GAPS },
    );
    expect(failures).toEqual([]);
  });
});
