/**
 * A column the code only filters on, read from Python and from Ruby
 * against the table a Prisma schema declares. `email` is read by the
 * filter on a delete and `expires` by a range on a select, so neither
 * is write-only. `note` is written and never read, and stays reported.
 * The Prisma integration test covers the same case in TypeScript.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { checkAll } from "@suss/checker";
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";
import { withActiveRecord } from "@suss/framework-activerecord";
import { fastapiFramework } from "@suss/framework-fastapi";
import { withSqlalchemy } from "@suss/framework-sqlalchemy";
import railsFramework from "@suss/packs/rails";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../fixtures/storage-filters",
);
const POSTGRES = { storageSystem: "postgresql" } as const;

function writeOnlyColumns(findings: Finding[]): string[] {
  return findings
    .filter((f) => f.kind === "boundaryFieldUnused" && f.aspect === "read")
    .map((f) => /declares "(\w+)"/.exec(f.description)?.[1] ?? "")
    .sort();
}

function checkedAgainstSchema(code: BehavioralSummary[]): Finding[] {
  const declared = prismaSchemaFileToSummaries(
    path.join(fixtureRoot, "schema.prisma"),
  );
  return checkAll([...declared, ...code]).findings;
}

describe("a column only a filter reads", () => {
  it("is read from SQLAlchemy, whether the filter compares with == or >=", async () => {
    const sourceRoot = path.join(fixtureRoot, "python");
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(sourceRoot),
      packs: [withSqlalchemy(fastapiFramework(), POSTGRES)],
      roots: [sourceRoot],
      workspaceRoot: sourceRoot,
    });

    expect(writeOnlyColumns(checkedAgainstSchema(summaries))).toEqual(["note"]);
  });

  it("is read from ActiveRecord, whether the where hash names a value or a range", async () => {
    const railsRoot = path.join(fixtureRoot, "ruby");
    const appRoot = path.join(railsRoot, "app");
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(appRoot),
      packs: [
        withActiveRecord(
          railsFramework({
            root: appRoot,
            routesFile: path.join(railsRoot, "config/routes.rb"),
          }),
          POSTGRES,
        ),
      ],
      projectRoot: railsRoot,
    });

    expect(writeOnlyColumns(checkedAgainstSchema(summaries))).toEqual(["note"]);
  });
});
