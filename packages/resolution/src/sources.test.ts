// The source question over facts written by hand, so what is under test
// is the walk from a value to where it came from.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { askSources } from "./sources.js";

function databaseOf(facts: Array<[string, ...string[]]>): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

/** `(req) => { const tenant = req.headers["x-tenant-id"]; ... tenant ... }` */
const HANDLER: Array<[string, ...string[]]> = [
  ["func", "handler"],
  ["paramOf", "handler", "0", "req"],
  ["binds", "reqRef", "req"],
  ["readsProperty", "headers", "reqRef", "headers"],
  ["readsProperty", "tenantRead", "headers", "x-tenant-id"],
  ["binds", "tenant", "tenantRead"],
  ["binds", "tenantRef", "tenant"],
];

describe("askSources", () => {
  it("ends at the handler's parameter, with the properties read off it", () => {
    const db = databaseOf(HANDLER);
    expect(askSources(db, ["tenantRef"]).get("tenantRef")).toEqual([
      {
        key: "req",
        path: ["headers", "x-tenant-id"],
        computedAt: null,
        conversions: [],
        end: { is: "parameter", of: "handler" },
      },
    ]);
  });

  it("goes through a helper's result and stops at the helper's own parameter", () => {
    const db = databaseOf([
      ...HANDLER,
      ["func", "tenantOf"],
      ["paramOf", "tenantOf", "0", "r"],
      ["binds", "rRef", "r"],
      ["readsProperty", "bodyRead", "rRef", "body"],
      ["returnsValue", "tenantOf", "bodyRead"],
      ["binds", "tenantOfRef", "tenantOf"],
      ["call", "helperCall", "tenantOfRef"],
      ["callArg", "helperCall", "0", "reqRef"],
    ]);
    expect(askSources(db, ["helperCall"]).get("helperCall")).toEqual([
      {
        key: "r",
        path: ["body"],
        computedAt: null,
        conversions: [],
        end: { is: "parameter", of: "tenantOf" },
      },
    ]);
  });

  it("stops at a helper's call when the question is which input a guard reads", () => {
    const db = databaseOf([
      ["func", "tenantOf"],
      ["paramOf", "tenantOf", "0", "r"],
      ["returnsValue", "tenantOf", "r"],
      ["binds", "tenantOfRef", "tenantOf"],
      ["call", "helperCall", "tenantOfRef"],
      ["binds", "tenant", "helperCall"],
      ["binds", "tenantRef", "tenant"],
    ]);
    expect(
      askSources(db, ["tenantRef"], undefined, "wantedInputRead").get(
        "tenantRef",
      ),
    ).toEqual([
      {
        key: "helperCall",
        path: [],
        computedAt: null,
        conversions: [],
        end: { is: "call" },
      },
    ]);
  });

  it("stops at a library call, a literal and a library import", () => {
    const db = databaseOf([
      ["call", "verifyCall", "verifyRef"],
      ["imports", "verifyRef", "jsonwebtoken", "verify"],
      ["readsProperty", "claim", "verifyCall", "tenantId"],
      ["writtenValue", "literal"],
      ["fallbackBranch", "either", "claim"],
      ["fallbackBranch", "either", "literal"],
      ["imports", "request", "flask", "request"],
      ["readsProperty", "argsRead", "request", "args"],
    ]);
    const found = askSources(db, ["either", "argsRead"]);
    expect(found.get("either")).toEqual([
      {
        key: "literal",
        path: [],
        computedAt: null,
        conversions: [],
        end: { is: "written" },
      },
      {
        key: "verifyCall",
        path: ["tenantId"],
        computedAt: null,
        conversions: [],
        end: { is: "call" },
      },
    ]);
    expect(found.get("argsRead")).toEqual([
      {
        key: "request",
        path: ["args"],
        computedAt: null,
        conversions: [],
        end: { is: "import", module: "flask", name: "request" },
      },
    ]);
  });

  it("keeps the key of an entry read at a key the source writes out", () => {
    const db = databaseOf([
      ["func", "action"],
      ["paramOf", "action", "0", "params"],
      ["readsEntry", "entry", "params", "tenant_id"],
    ]);
    expect(askSources(db, ["entry"]).get("entry")).toEqual([
      {
        key: "params",
        path: ["tenant_id"],
        computedAt: null,
        conversions: [],
        end: { is: "parameter", of: "action" },
      },
    ]);
  });

  it("says when the way to a value read an entry at a computed key", () => {
    const db = databaseOf([
      ...HANDLER,
      ["readsKeyed", "entry", "reqRef", "name"],
    ]);
    expect(askSources(db, ["entry"]).get("entry")).toEqual([
      {
        key: "req",
        path: [],
        computedAt: "entry",
        conversions: [],
        end: { is: "parameter", of: "handler" },
      },
    ]);
  });

  it("goes through the language's own conversion and says it did", () => {
    const db = databaseOf([
      ...HANDLER,
      ["call", "toNumber", "numberRef"],
      ["converts", "toNumber", "tenantRef", "Number"],
      ["binds", "id", "toNumber"],
      ["binds", "idRef", "id"],
    ]);
    expect(askSources(db, ["idRef"]).get("idRef")).toEqual([
      {
        key: "req",
        path: ["headers", "x-tenant-id"],
        computedAt: null,
        conversions: ["Number"],
        end: { is: "parameter", of: "handler" },
      },
    ]);
  });

  it("walks a member two branches reach once, and ends at a name nothing writes", () => {
    const db = databaseOf([
      ["fallbackBranch", "either", "left"],
      ["fallbackBranch", "either", "right"],
      ["binds", "left", "shared"],
      ["binds", "right", "shared"],
    ]);
    expect(askSources(db, ["either"]).get("either")).toEqual([
      {
        key: "shared",
        path: [],
        computedAt: null,
        conversions: [],
        end: { is: "other" },
      },
    ]);
  });

  it("asks nothing for no values", () => {
    expect(askSources(databaseOf(HANDLER), [])).toEqual(new Map());
  });
});
