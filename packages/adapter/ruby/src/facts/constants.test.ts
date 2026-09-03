import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
import { resolveValues } from "./resolve.js";
import { emitValueFacts } from "./values.js";

/** Facts for a whole run, so a constant can be followed out of the file it is read in. */
async function factsFor(files: Record<string, string>) {
  const db = new Database();
  const constants = [];
  for (const [file, source] of Object.entries(files)) {
    const tree = await parseRuby(source);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
  }
  emitConstantBindings(db, constants);
  return db;
}

const bindingsOf = (db: Database): string[][] =>
  db.facts("binds").map((row) => row.map(String));

/** A key's span width, so a caller can tell a nested definition's key from its enclosing one. */
function width(key: string): number {
  const [start, end] = (key.split(":")[1] ?? "").split("-").map(Number);
  return (end ?? 0) - (start ?? 0);
}

describe("a Ruby constant", () => {
  it("binds to the class another file declares", async () => {
    const db = await factsFor({
      "order.rb": "class Order\n  def load\n  end\nend\n",
      "use.rb": "value = Order\n",
    });

    const classKey = db
      .facts("objectValue")
      .map((row) => String(row[0]))
      .find((key) => key.startsWith("order.rb"));
    expect(bindingsOf(db)).toContainEqual(["use.rb#Order", classKey]);
  });

  it("follows a name written under its module", async () => {
    const db = await factsFor({
      "order.rb": "module Types\n  class Order\n  end\nend\n",
      "use.rb": "value = Types::Order\n",
    });

    // A module is an object too, so this file has two `objectValue` keys.
    // The class is the narrower span.
    const [classKey] = db
      .facts("objectValue")
      .map((row) => String(row[0]))
      .filter((key) => key.startsWith("order.rb:"))
      .sort((a, b) => width(a) - width(b));
    const scoped = bindingsOf(db).find(([from]) => from.startsWith("use.rb:"));
    expect(scoped?.[1]).toBe(classKey);
  });

  it("reads a bare name inside a module as that module's own", async () => {
    const db = await factsFor({
      "types.rb": [
        "module Types",
        "  class Order",
        "  end",
        "  class Wrapper",
        "    def build",
        "      Order",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
      "other.rb": "class Order\nend\n",
    });

    // Both `Types::Order` and the top-level `Order` exist. The read inside
    // `Types` finds its own, which is what Ruby does.
    const inner = bindingsOf(db).find(([from]) => from === "types.rb#Order");
    expect(inner?.[1]?.startsWith("types.rb")).toBe(true);
  });

  it("says nothing when two files declare one name", async () => {
    const db = await factsFor({
      "one.rb": "class Order\nend\n",
      "two.rb": "class Order\nend\n",
      "use.rb": "value = Order\n",
    });

    expect(bindingsOf(db).some(([from]) => from === "use.rb#Order")).toBe(
      false,
    );
  });

  it("resolves a method called on a class another file declares", async () => {
    const db = await factsFor({
      "loader.rb": [
        "class Loader",
        "  def namespaces",
        "    [1]",
        "  end",
        "end",
        "",
      ].join("\n"),
      "app.rb": "loader = Loader.new\nfound = loader.namespaces\n",
    });

    // `loader.namespaces` takes no arguments, so Ruby writes it as a property
    // read rather than a call, and the read is what to ask about.
    const read = db
      .facts("readsProperty")
      .find((row) => String(row[2]) === "namespaces");
    resolveValues(db, [String(read?.[0])]);

    const method = db
      .facts("func")
      .map((row) => String(row[0]))
      .find((key) => key.startsWith("loader.rb"));
    expect(
      db
        .facts("comesTo")
        .filter((row) => row[0] === read?.[0])
        .map((row) => String(row[1])),
    ).toEqual([method]);
  });
});
