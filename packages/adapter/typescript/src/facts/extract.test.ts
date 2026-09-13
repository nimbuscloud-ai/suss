// The facts one file produces, read straight off the database, before
// any rule has looked at them. Everything else about extraction is
// tested through the store, which runs the rules as well.

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { createNodeTable, extractFileFacts } from "./extract.js";

import type { NodeTable } from "./extract.js";

function factsFor(files: Record<string, string>): {
  db: Database;
  table: NodeTable;
} {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const db = new Database();
  const table = createNodeTable();
  for (const sourceFile of project.getSourceFiles()) {
    extractFileFacts(db, table, sourceFile);
  }
  return { db, table };
}

/** One relation's tuples, with each node id swapped for the source text it points at. */
function rows(db: Database, table: NodeTable, relation: string): string[][] {
  return db.facts(relation).map((row) =>
    row.map((value) => {
      const node = table.byId.get(String(value));
      return node === undefined
        ? String(value)
        : node.getText().replace(/\s+/g, " ");
    }),
  );
}

describe("a function's declared return type", () => {
  it("records the class the annotation names, and the name as written", () => {
    const { db, table } = factsFor({
      "/mod.ts": [
        "export class Router { handle() {} }",
        "export function makeRouter(): Router { throw new Error('nothing'); }",
        "",
      ].join("\n"),
    });

    expect(rows(db, table, "returnsClass")).toEqual([
      [
        "export function makeRouter(): Router { throw new Error('nothing'); }",
        "export class Router { handle() {} }",
      ],
    ]);
    expect(rows(db, table, "returnsNamed").map((row) => row[1])).toEqual([
      "Router",
    ]);
  });

  it("reads a promise through to the class inside it", () => {
    const { db, table } = factsFor({
      "/mod.ts": [
        "export class Router { handle() {} }",
        "export async function makeRouter(): Promise<Router> { throw new Error('nothing'); }",
        "",
      ].join("\n"),
    });

    expect(rows(db, table, "returnsClass").map((row) => row[1])).toEqual([
      "export class Router { handle() {} }",
    ]);
  });

  it("says nothing about a generic that hands back a container", () => {
    const { db } = factsFor({
      "/mod.ts": [
        "export class Router { handle() {} }",
        "export function everyRouter(): Array<Router> { throw new Error('nothing'); }",
        "",
      ].join("\n"),
    });

    expect(db.size("returnsClass")).toBe(0);
    expect(db.facts("returnsNamed").map((row) => String(row[1]))).toEqual([
      "Array",
    ]);
  });

  it("leaves the annotation alone when the body states what it returns", () => {
    const { db } = factsFor({
      "/mod.ts": [
        "export class Router { handle() {} }",
        "declare const cached: Router;",
        "export function makeRouter(): Router { return cached; }",
        "",
      ].join("\n"),
    });

    expect(db.size("returnsValue")).toBe(1);
    expect(db.size("returnsClass")).toBe(0);
    expect(db.size("returnsNamed")).toBe(0);
  });

  it("keeps only the name for a type no class in the run declares", () => {
    const { db } = factsFor({
      "/mod.ts": [
        "interface Client { send(): void }",
        "export function makeClient(): Client { throw new Error('nothing'); }",
        "",
      ].join("\n"),
    });

    expect(db.size("returnsClass")).toBe(0);
    expect(db.facts("returnsNamed").map((row) => String(row[1]))).toEqual([
      "Client",
    ]);
  });
});

describe("what a class's bodies store on the receiver", () => {
  it("says the class itself is what runs when one of it is made", () => {
    const { db, table } = factsFor({
      "/mod.ts": [
        "export class Api { items() {} }",
        "export const v1 = new Api();",
        "",
      ].join("\n"),
    });

    expect(rows(db, table, "initializes")).toEqual([
      ["export class Api { items() {} }", "export class Api { items() {} }"],
    ]);
  });

  it("keys a constructor's store to the class and a method's to the method", () => {
    const { db, table } = factsFor({
      "/mod.ts": [
        "declare function create(): string;",
        "declare function warm(): string;",
        "export class Api {",
        "  private client!: string;",
        "  private cache!: string;",
        "  constructor() { this.client = create(); }",
        "  prime() { this.cache = warm(); }",
        "}",
        "export const v1 = new Api();",
        "",
      ].join("\n"),
    });

    const stored = rows(db, table, "storesProperty");
    expect(stored.map((row) => [row[1], row[2]])).toEqual([
      ["client", "create()"],
      ["cache", "warm()"],
    ]);
    expect(stored[0]?.[0]?.startsWith("export class Api {")).toBe(true);
    expect(stored[1]?.[0]).toBe("prime() { this.cache = warm(); }");
  });

  it("settles two stores to one name in one body on the last of them", () => {
    const { db, table } = factsFor({
      "/mod.ts": [
        "declare function first(): string;",
        "declare function second(): string;",
        "export class Api {",
        "  private page!: string;",
        "  constructor() { this.page = first(); this.page = second(); }",
        "}",
        "export const v1 = new Api();",
        "",
      ].join("\n"),
    });

    expect(rows(db, table, "storesProperty").map((row) => row[2])).toEqual([
      "second()",
    ]);
  });
});
