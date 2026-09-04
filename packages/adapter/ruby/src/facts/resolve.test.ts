import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { resolveValues } from "./resolve.js";
import { emitValueFacts } from "./values.js";

async function factsFor(source: string) {
  const tree = await parseRuby(source);
  const db = new Database();
  emitValueFacts(db, "f.rb", tree.rootNode);
  return db;
}

describe("resolving a value across a Ruby file", () => {
  it("derives a call reached through a wrapper as written by the construction it returns", async () => {
    const db = await factsFor(
      [
        "class Client",
        "end",
        "",
        "def make_client",
        "  Client.new",
        "end",
        "",
        "make_client().send_request(1)",
      ].join("\n"),
    );

    const wrapperCall = db
      .facts("call")
      .find((row) => String(row[1]).endsWith("#make_client"));
    expect(wrapperCall, "the wrapper call was not recorded").toBeDefined();
    const clientClass = db.facts("objectValue")[0];
    expect(clientClass, "the class was not recorded").toBeDefined();

    resolveValues(db, [String(wrapperCall?.[0])]);
    const written = db
      .facts("wantedIsWrittenAs")
      .filter((row) => row[0] === wrapperCall?.[0])
      .map((row) => String(row[1]));
    expect(written).toContain(String(clientClass?.[0]));
  });
});
