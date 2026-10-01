import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pinAutomaticTypes } from "./automaticTypes.js";

describe("pinAutomaticTypes", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-automatic-types-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): string {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    return full;
  }

  function projectReferencingMissingTypes(): {
    project: Project;
    file: string;
  } {
    const tsconfig = write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const file = write(
      "src/orders.ts",
      [
        '/// <reference path="../node_modules/@types/ledger/index.d.ts" />',
        "export const orderTotal = (count: number): number => count * 2;",
      ].join("\n"),
    );
    const project = new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: true,
    });
    project.addSourceFileAtPath(file);
    return { project, file };
  }

  function typeOfFirstStatement(project: Project, file: string): string {
    const statement = project.getSourceFileOrThrow(file).getStatements()[0];
    return project.getTypeChecker().getTypeAtLocation(statement).getText();
  }

  it("builds a program when a file references a missing node_modules/@types", () => {
    const { project, file } = projectReferencingMissingTypes();

    pinAutomaticTypes(project);

    expect(() => typeOfFirstStatement(project, file)).not.toThrow();
    expect(project.getCompilerOptions().types).toEqual([]);
  });

  it("lists the packages a node_modules/@types folder has", () => {
    write("node_modules/@types/ledger/index.d.ts", "declare const x: 1;\n");
    const { project } = projectReferencingMissingTypes();

    pinAutomaticTypes(project);

    expect(project.getCompilerOptions().types).toEqual(["ledger"]);
  });

  it("keeps a types list the tsconfig sets", () => {
    const { project } = projectReferencingMissingTypes();
    project.compilerOptions.set({ types: ["node"] });

    pinAutomaticTypes(project);

    expect(project.getCompilerOptions().types).toEqual(["node"]);
  });
});
