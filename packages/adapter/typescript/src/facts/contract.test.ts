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
  "a value another file declares": {
    "/source.ts": "export const value = 1;\n",
    "/f.ts":
      "import { value as renamed } from './source';\nexport const used = renamed;\n",
  },
};

describe("the TypeScript adapter satisfies the fact contract", () => {
  it("keys every fact the way the rules expect", async () => {
    const failures = await checkFactContract(SOURCES, (files) => {
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
    });
    expect(failures).toEqual([]);
  });
});
