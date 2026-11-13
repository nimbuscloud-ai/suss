import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { GLOBAL_MODULE } from "@suss/resolution";

import { rubyFactSource } from "../factSource.js";
import { parseRuby } from "../parser.js";
import { bindEvaluator } from "../values/evaluator.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
import { resolveValues } from "./resolve.js";
import { emitValueFacts } from "./values.js";

/** Facts for a whole run, so a constant can be followed out of the file it is read in. */
async function factsFor(files: Record<string, string>) {
  const db = new Database();
  const constants = [];
  const parsed = [];
  for (const [file, source] of Object.entries(files)) {
    const tree = await parseRuby(source);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
    parsed.push({ file, root: tree.rootNode });
  }
  emitConstantBindings(db, constants);
  bindEvaluator(db, { files: parsed, definitions: new Map() });
  return db;
}

const bindingsOf = (db: Database): string[][] =>
  db.facts("binds").map((row) => row.map(String));

/** A key's span width, so a caller can tell a nested definition's key from its enclosing one. */
function width(key: string): number {
  const [start, end] = (key.split(":")[1] ?? "").split("-").map(Number);
  return (end ?? 0) - (start ?? 0);
}

describe("a Ruby constant a library defines", () => {
  const importsOf = (db: Database): string[][] =>
    db.facts("imports").map((row) => row.map(String));

  it("is imported from the global module under its path when no file defines its root", async () => {
    const db = await factsFor({
      "send.rb": [
        "module Orders",
        "  def self.send_one",
        "    Aws::SQS::Client.new.send_message(queue_url: 'q')",
        "    Ledger.publish('ledger')",
        "  end",
        "end",
      ].join("\n"),
    });

    const imports = importsOf(db);
    expect(imports).toContainEqual(["send.rb#Ledger", GLOBAL_MODULE, "Ledger"]);
    expect(imports).toContainEqual([
      expect.stringMatching(/^send\.rb:/),
      GLOBAL_MODULE,
      "Aws::SQS::Client",
    ]);
  });

  it("is read by the fact source as coming from the library whose constant its path starts with", async () => {
    const db = await factsFor({
      "send.rb": "Aws::SQS::Client.new.send_message(queue_url: 'q')\n",
    });
    const [client] = importsOf(db).map(([ref]) => ref as string);
    const source = rubyFactSource(db);

    expect(source.textOf(client as string)).toBe("Aws::SQS::Client");
    expect(source.importedFrom(client as string, "Aws::SQS")).toBe(true);
    expect(source.importedFrom(client as string, "Aws::SQS::Client")).toBe(
      true,
    );
    expect(source.importedFrom(client as string, "Aws::S3")).toBe(false);
  });

  it("is not imported when a file in the run defines its root, even one reopened under it", async () => {
    const db = await factsFor({
      "ledger.rb": "module Ledger\nend\n",
      "client.rb": "class Aws::SQS::Client\nend\n",
      "use.rb": "Ledger.publish('ledger')\nAws::SQS::Client.new\n",
    });

    expect(importsOf(db)).toEqual([
      [expect.stringMatching(/^use\.rb:/), GLOBAL_MODULE, "Aws::SQS::Client"],
    ]);
  });
});

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

  it("reads a name written with a leading `::` from the top level, whatever module it is inside", async () => {
    const db = await factsFor({
      "types.rb": [
        "module Types",
        "  class Order",
        "  end",
        "  class Wrapper",
        "    def build",
        "      ::Order",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
      "other.rb": "class Order\nend\n",
    });

    const absolute = bindingsOf(db).find(([from]) =>
      from.startsWith("types.rb:"),
    );
    expect(absolute?.[1]?.startsWith("other.rb")).toBe(true);
  });

  it("names a module declared with a leading `::` from the top level, and binds a read of it", async () => {
    const db = await factsFor({
      "engine.rb": [
        "module ::Boards",
        "  class Engine < ::Rails::Engine",
        "  end",
        "end",
        "",
      ].join("\n"),
      "routes.rb": "mount Boards::Engine, at: '/boards'\n",
    });

    const names = db.facts("rbConstantName").map((row) => String(row[1]));
    expect(names).toEqual(["Boards", "Boards::Engine"]);
    const engineKey = db
      .facts("rbConstantName")
      .find((row) => row[1] === "Boards::Engine")?.[0];
    const mounted = bindingsOf(db).find(([from]) =>
      from.startsWith("routes.rb:"),
    );
    expect(mounted?.[1]).toBe(engineKey);
    expect(
      db.facts("exportsAs").map((row) => [String(row[0]), String(row[1])]),
    ).toContainEqual(["engine.rb", "Boards"]);
  });

  it("binds a name two files open to the first body, the way Ruby reopens one class", async () => {
    const db = await factsFor({
      "one.rb": "class Order\nend\n",
      "two.rb": "class Order\nend\n",
      "use.rb": "value = Order\n",
    });

    expect(
      bindingsOf(db).find(([from]) => from === "use.rb#Order")?.[1],
    ).toMatch(/^one\.rb:/);
  });

  it("does not read the name a class or module is declared with as a use of it", async () => {
    const db = await factsFor({
      "billing.rb": "module Billing\nend\n",
      "store.rb": "module Billing\n  Limit = 1\nend\n",
    });

    expect(
      bindingsOf(db).filter(
        ([from, to]) =>
          from.startsWith("store.rb") && to?.startsWith("billing.rb"),
      ),
    ).toEqual([]);
    expect(db.facts("importsFile")).toEqual([]);
  });

  it("says nothing when two files assign one name", async () => {
    const db = await factsFor({
      "one.rb": "Limit = 1\n",
      "two.rb": "Limit = 2\n",
      "use.rb": "value = Limit\n",
    });

    expect(bindingsOf(db).some(([from]) => from === "use.rb#Limit")).toBe(
      false,
    );
  });

  it("takes the class over a script that assigns the same name", async () => {
    const db = await factsFor({
      "one.rb": "class Order\nend\n",
      "bench.rb": "Order = Data.define(:id)\n",
      "use.rb": "value = Order\n",
    });

    expect(
      bindingsOf(db).find(([from]) => from === "use.rb#Order")?.[1],
    ).toMatch(/^one\.rb:/);
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
        .facts("wantedComesTo")
        .filter((row) => row[0] === read?.[0])
        .map((row) => String(row[1])),
    ).toEqual([method]);
  });
});
