import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { type CaseFiles, checkFactContract } from "@suss/resolution";

import { createNodeTable, extractFileFacts } from "./extract.js";

/**
 * TypeScript's own spelling of each case. The contract was read off this
 * adapter, so a case it fails is a case the contract has wrong.
 */
const SOURCES: Record<string, CaseFiles> = {
  "two functions, one parameter name": {
    "/f.ts": [
      "export function outer(loader: unknown) { return loader; }",
      "export function inner(loader: unknown) { return loader; }",
      "",
    ].join("\n"),
  },
  "a name read inside a function": {
    "/f.ts": "export function handler(order: unknown) { return order; }\n",
  },
  "a function calling its parameter": {
    "/f.ts": "export function guard(fn: (n: number) => void) { fn(1); }\n",
  },
  "a name bound to a call": {
    "/f.ts":
      "declare function build(): unknown;\nexport const registry = build();\n",
  },
  "a written-out sequence": {
    "/f.ts":
      "declare const first: unknown, second: unknown;\nexport const items = [first, second];\n",
  },
  "a module exporting a name": { "/f.ts": "export function build() {}\n" },
  "a class declaring a method": {
    "/f.ts": "export class Loader {\n  load() {}\n}\n",
  },
  "a class constructed with an argument": {
    "/f.ts": [
      "declare const source: unknown;",
      "export class Loader {",
      "  constructor(readonly from: unknown) {}",
      "}",
      "export const loader = new Loader(source);",
      "",
    ].join("\n"),
  },
  "a name declared as a fallback": {
    "/f.ts": [
      "declare const globalCache: { client?: unknown };",
      "declare function build(): unknown;",
      "export const client = globalCache.client || build();",
      "",
    ].join("\n"),
  },
  "a property written through a name": {
    "/f.ts": [
      "export class ReportJob {",
      "  retries = 0;",
      "}",
      "export const job = new ReportJob();",
      "job.retries = 3;",
      "",
    ].join("\n"),
  },
  "a class extending another": {
    "/f.ts": [
      "class User {",
      "  save() {}",
      "}",
      "export class Admin extends User {}",
      "",
    ].join("\n"),
  },
  "a table of functions called by a key worked out at run time": {
    "/f.ts": [
      "declare function onCreated(payload: string): void;",
      "declare function onDeleted(payload: string): void;",
      'const TABLE = { "created": onCreated, deleted: onDeleted };',
      "export function dispatch(kind: string, payload: string) {",
      "  return TABLE[kind as keyof typeof TABLE](payload);",
      "}",
      "export function dispatchAny(kind: string, payload: string) {",
      "  return (TABLE as Record<string, (p: string) => void>)[kind](payload);",
      "}",
      "",
    ].join("\n"),
  },
  "a function written into a table under a computed key": {
    "/f.ts": [
      "const REGISTRY: Record<string, () => void> = {};",
      "export function register(name: string, handler: () => void) {",
      "  REGISTRY[name] = handler;",
      "}",
      "",
    ].join("\n"),
  },
  "a list written with a spread": {
    "/f.ts":
      "declare const first: unknown, rest: unknown[];\nexport const items = [first, ...rest];\n",
  },
  "an object written with a spread": {
    "/f.ts":
      "declare const first: unknown, rest: object;\nexport const options = { a: first, ...rest };\n",
  },
  "a template string with a hole": {
    "/f.ts": [
      "declare function lookup(): string;",
      "const id = lookup();",
      "export const path = `/users/${id}/posts`;",
      "",
    ].join("\n"),
  },
  "a callback given each element of a list": {
    "/f.ts":
      "export function names(users: string[]) {\n  return users.map((user) => user);\n}\n",
  },
  "a callback given each position in a list": {
    "/f.ts":
      "export function positions(users: string[]) {\n  return users.map((user, at) => at);\n}\n",
  },
  "a value another file declares": {
    "/source.ts": "export const value = 1;\n",
    "/f.ts":
      "import { value as renamed } from './source';\nexport const used = renamed;\n",
  },
};

/** The cases this adapter meets another way, and why. */
const KNOWN = {
  known: {
    "a function written into a table under a computed key":
      "extraction is lazy, so the store reads the writes into a table when a call through that table is asked about, and file extraction states none",
    "a template string with a hole":
      "extraction is lazy, so the value in a hole gets its facts when a question reaches it, and file extraction states only its key",
  },
};

describe("the TypeScript adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(
      SOURCES,
      (files) => {
        const project = new Project({ useInMemoryFileSystem: true });
        for (const [name, source] of Object.entries(files)) {
          project.createSourceFile(name, source);
        }
        const db = new Database();
        const table = createNodeTable();
        for (const sourceFile of project.getSourceFiles()) {
          extractFileFacts(db, table, sourceFile);
        }
        return db;
      },
      KNOWN,
    );
    expect(failures).toEqual([]);
  });
});
