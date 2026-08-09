import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { type CaseFiles, checkFactContract } from "@suss/resolution";

import { parseRuby } from "../parser.js";
import { emitValueFacts } from "./values.js";

/** Ruby's own spelling of each case the contract states. */
const SOURCES: Record<string, CaseFiles> = {
  "two functions, one parameter name": {
    "f.rb": [
      "def outer(loader)",
      "end",
      "",
      "def inner(loader)",
      "end",
      "",
    ].join("\n"),
  },
  "a name read inside a function": {
    "f.rb": ["def handler(order)", "  return order", "end", ""].join("\n"),
  },
  "a name bound to a call": { "f.rb": "registry = build()\n" },
  "a written-out sequence": { "f.rb": "items = [first, second]\n" },
  "a module exporting a name": { "f.rb": "def build\nend\n" },
  "an import renaming what it brings in": {
    "source.rb": "value = 1\n",
    "f.rb": "require 'source'\n",
  },
};

describe("the Ruby adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(
      SOURCES,
      async (files) => {
        const db = new Database();
        for (const [name, source] of Object.entries(files)) {
          const tree = await parseRuby(source);
          emitValueFacts(db, name, tree.rootNode);
        }
        return db;
      },
      {
        known: {
          // Ruby resolves no `require`, so nothing says which file a name
          // came from. Reading a value across a file waits on that.
          "an import renaming what it brings in":
            "the adapter resolves no require",
        },
      },
    );
    expect(failures).toEqual([]);
  });
});
