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
  "a name bound to a call": { "f.py": "registry = build()\n" },
  "a written-out sequence": { "f.py": "items = [first, second]\n" },
  "a module exporting a name": { "f.py": "def build():\n    pass\n" },
  "an import renaming what it brings in": {
    "source.py": "value = 1\n",
    "f.py": "from source import value as renamed\n",
  },
};

describe("the Python adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(SOURCES, async (files) => {
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
    });
    expect(failures).toEqual([]);
  });
});
