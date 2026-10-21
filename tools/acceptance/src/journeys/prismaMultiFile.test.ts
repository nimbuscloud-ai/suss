// A Prisma schema split over a folder that only the project's `prisma
// generate` script points at. The client's calls and the schema have to
// say the same database, and every file of the schema has to be read.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { copyOfFixture, readJson, runSuss } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function storageTouchedBy(summaries: BehavioralSummary[]): string[] {
  const touched = summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) =>
      transition.effects.flatMap((effect) =>
        effect.type === "interaction" &&
        effect.binding.semantics.name === "storage"
          ? [
              `${effect.binding.semantics.storageSystem}:${effect.binding.semantics.container}`,
            ]
          : [],
      ),
    ),
  );
  return [...new Set(touched)].sort();
}

describe("read a Prisma schema split over a folder", () => {
  const project = copyOfFixture("prisma-multi-file");
  const code = path.join(project, "summaries", "code.json");
  const schema = path.join(project, "summaries", "schema.json");

  beforeAll(() => {
    const extract = runSuss(
      ["extract", "-f", "express", "-f", "prisma", "-o", code],
      { cwd: project },
    );
    expect(extract.status, extract.stderr).toBe(0);

    const contract = runSuss(
      [
        "contract",
        "--from",
        "prisma",
        "prisma/schema/schema.prisma",
        "-o",
        schema,
      ],
      { cwd: project },
    );
    expect(contract.status, contract.stderr).toBe(0);
  });

  it("binds the client's calls to the database the schema's datasource says", () => {
    expect(storageTouchedBy(readJson(code) as BehavioralSummary[])).toEqual([
      "mysql:Link",
    ]);
  });

  it("reads the models in every file of the schema", () => {
    const models = (readJson(schema) as BehavioralSummary[])
      .map((summary) => `${summary.identity.name} ${summary.location.file}`)
      .sort();

    expect(models).toEqual([
      "Link prisma/schema/link.prisma",
      "User prisma/schema/schema.prisma",
    ]);
  });

  it("pairs the two sides and reports the field the schema does not declare", () => {
    const check = runSuss(["check", "--dir", path.dirname(code)], {
      cwd: project,
    });

    expect(check.stdout).toContain(
      'get selects "titel" on Link (mysql) but the contract declares no titel field.',
    );
  });
});
