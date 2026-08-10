import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { type CaseFiles, checkFactContract } from "@suss/resolution";

import { parseRuby } from "../parser.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
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
  "a class declaring a method": {
    "f.rb": "class Loader\n  def load\n  end\nend\n",
  },
  "a value another file declares": {
    "source.rb": "class Order\nend\n",
    "f.rb": "value = Order\n",
  },
};

describe("the Ruby adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(SOURCES, async (files) => {
      const db = new Database();
      const constants = [];
      for (const [name, source] of Object.entries(files)) {
        const tree = await parseRuby(source);
        emitValueFacts(db, name, tree.rootNode);
        constants.push(collectFileConstants(name, tree.rootNode));
      }
      emitConstantBindings(db, constants);
      return db;
    });
    expect(failures).toEqual([]);
  });
});
