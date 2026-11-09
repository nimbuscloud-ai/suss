// The facts a declared discovery pattern reads and no rule does: the
// directive prologue of a module or a function, and the tag a JSX element
// renders.

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { resolutionProgram, resolutionUnderProgram } from "@suss/resolution";

import { createNodeTable, extractFileFacts } from "./extract.js";

function rowsFor(source: string, relation: string): string[][] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("/mod.tsx", source);
  const db = new Database();
  const table = createNodeTable([]);
  extractFileFacts(db, table, sourceFile);
  return db.facts(relation).map((row) =>
    row.map((value) => {
      const node = table.byId.get(String(value));
      return node === undefined
        ? String(value)
        : node.getText().replace(/\s+/g, " ");
    }),
  );
}

describe("marks", () => {
  it("states each word of a module's prologue against the file", () => {
    expect(
      rowsFor(
        '"use server";\n"use strict";\nexport function save() {}\n',
        "marks",
      ),
    ).toEqual([
      ["/mod.tsx", "use server"],
      ["/mod.tsx", "use strict"],
    ]);
  });

  it("states a function's prologue against the function, and stops at the first other statement", () => {
    expect(
      rowsFor(
        'export async function save() {\n  "use server";\n  run();\n  "not a directive";\n}\n',
        "marks",
      ),
    ).toEqual([
      [
        'export async function save() { "use server"; run(); "not a directive"; }',
        "use server",
      ],
    ]);
  });

  it("states nothing for a string that comes after a statement", () => {
    expect(rowsFor('run();\n"use server";\n', "marks")).toEqual([]);
  });
});

describe("jsxElement", () => {
  it("states the tag an element renders, for a self-closing element and an element with children", () => {
    expect(
      rowsFor(
        "export function App() {\n  return cond ? <Page /> : <Layout><Page /></Layout>;\n}\n",
        "jsxElement",
      ),
    ).toEqual([
      ["<Page />", "Page"],
      ["<Layout><Page /></Layout>", "Layout"],
    ]);
  });

  it("states nothing for a fragment, which renders no tag", () => {
    expect(rowsFor("export const App = () => <></>;\n", "jsxElement")).toEqual(
      [],
    );
  });
});

describe("the facts only a discovery pattern reads", () => {
  it("are read by no rule", () => {
    const readers = [resolutionProgram(), resolutionUnderProgram()]
      .flatMap((program) => program.rules)
      .filter((rule) =>
        rule.body.some(
          (literal) =>
            "relation" in literal &&
            ["marks", "jsxElement"].includes(literal.relation),
        ),
      );

    expect(readers).toEqual([]);
  });
});
