// A file's export statements stated alone, as `declarationExportedAs`
// reads them, against the same rows in the file's full facts.

import fs from "node:fs";
import path from "node:path";

import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { createTestProject } from "@suss/test-project";

import {
  createNodeTable,
  extractExportFacts,
  extractFileFacts,
} from "./extract.js";
import { ResolutionStore } from "./store.js";

import type { SourceFile } from "ts-morph";

const FIXTURES = path.resolve(__dirname, "../../../../../fixtures");

/** Every source file under the fixture folders the story reader and the React pack read. */
function fixtureFiles(): SourceFile[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 4 },
  });
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const folder of ["storybook", "storybook-imports/src", "react"]) {
    walk(path.join(FIXTURES, folder));
  }
  return files.map((file) => project.addSourceFileAtPath(file));
}

function exportRows(
  sourceFile: SourceFile,
  extract: typeof extractFileFacts,
): string[] {
  const db = new Database();
  extract(db, createNodeTable([]), sourceFile);
  return ["exportsAs", "reExports"].flatMap((relation) =>
    db.facts(relation).map((row) => `${relation} ${row.join(" ")}`),
  );
}

describe("a file's export statements alone", () => {
  it("state the export rows the file's full facts state, for every fixture a story reads", () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(20);
    for (const sourceFile of files) {
      expect(exportRows(sourceFile, extractExportFacts)).toEqual(
        exportRows(sourceFile, extractFileFacts),
      );
    }
  });

  it("state no row for an exported type, in either reading", () => {
    const project = createTestProject();
    const sourceFile = project.createSourceFile(
      "/types.ts",
      [
        "interface Props { label: string }",
        "enum Size { Small }",
        "const chip = (props: Props) => props.label;",
        "export { Props, Size, chip };",
      ].join("\n"),
    );
    const rows = exportRows(sourceFile, extractExportFacts);

    expect(rows).toEqual(exportRows(sourceFile, extractFileFacts));
    expect(rows.map((row) => row.split(" ")[2])).toEqual(["chip"]);
  });

  it("give what a module exports under a name through a re-export, and state none of its values", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/chip.ts",
      "export function Chip() { return helper(); }\nfunction helper() { return 1; }",
    );
    const barrel = project.createSourceFile(
      "/index.ts",
      'export { Chip as Renamed } from "./chip";',
    );
    const store = new ResolutionStore();
    const exported = store.declarationExportedAs(barrel, "Renamed");

    expect(
      exported.map((node) =>
        Node.isFunctionDeclaration(node) ? node.getName() : node.getKindName(),
      ),
    ).toEqual(["Chip"]);
    expect(store.declarationExportedAs(barrel, "Missing")).toEqual([]);
    expect(store.factAccess().db.size("func")).toBe(0);
  });
});
