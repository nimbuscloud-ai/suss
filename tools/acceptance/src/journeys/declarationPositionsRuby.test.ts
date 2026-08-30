/**
 * The Ruby member of the declaration-position set. Ruby runs a class body
 * like any other code, so a `field` call goes anywhere a statement goes,
 * and this reads one field per spelling and expects all of them. A row
 * that starts failing is a spelling somebody's schema uses and suss
 * stopped seeing.
 *
 * The last four rows are what suss cannot read. Each one is here so the
 * limit is something a person can look up rather than a route nobody
 * notices is missing.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyOfFixture, runSuss, writePackConfig } from "../harness.js";

/** Where the `field` call is written, and the summary it should produce. */
const FOUND: ReadonlyArray<readonly [string, string]> = [
  ["gql:R01Plain.value", "directly in the class body"],
  ["gql:R02If.value", "inside an if"],
  ["gql:R03Unless.value", "inside an unless"],
  ["gql:R04Case.value", "inside a case"],
  ["gql:R05DoBlock.value", "inside a do block"],
  ["gql:R06BraceBlock.value", "inside a brace block"],
  ["gql:R07BeginRescue.value", "inside a begin"],
  ["gql:R08Reopened.value", "in a second block reopening the class"],
  ["gql:R09NestedModule.value", "in a class written inside an if"],
  ["gql:R10While.value", "inside a while"],
  ["gql:R11ModifierIf.value", "with a modifier if"],
  ["gql:R12ClassEval.value", "inside a receiverless class_eval block"],
  ["gql:R13FieldBlock.value", "with a block configuring the field"],
  ["gql:R18ModelRead.value", "beside a resolver method written inside an if"],
];

/** A placement suss does not read, and the reason it does not. */
const UNREAD: ReadonlyArray<readonly [string, string]> = [
  [
    "R16IncludedModule",
    "the field is declared by a module's included hook, against the class the hook is handed",
  ],
  [
    "R17ClassEvalReceiver",
    "the field is declared outside any class body, on whatever the class_eval receiver evaluates to",
  ],
];

describe("a graphql-ruby field declared in any of the places Ruby allows", () => {
  const project = copyOfFixture("declaration-positions-ruby");
  const summariesFile = path.join(project, "summaries", "code.json");

  const graphql = writePackConfig(project, "graphql-ruby", {
    root: "app/graphql",
  });
  const activerecord = writePackConfig(project, "activerecord", {
    storageSystem: "postgresql",
  });

  const extract = runSuss(
    [
      "extract",
      "--lang",
      "ruby",
      "-f",
      `graphql-ruby=${path.basename(graphql)}`,
      "-f",
      `activerecord=${path.basename(activerecord)}`,
      "-o",
      "summaries/code.json",
    ],
    { cwd: project },
  );

  const inspect = runSuss(["inspect", summariesFile]);

  it("reads every file without complaint", () => {
    expect(extract.status, extract.stderr).toBe(0);
    expect(inspect.status, inspect.stderr).toBe(0);
  });

  for (const [summary, where] of FOUND) {
    it(`finds the field declared ${where}`, () => {
      expect(inspect.stdout).toContain(summary);
    });
  }

  it("names a field whose name is computed, and binds it to nothing", () => {
    expect(inspect.stdout).toContain("R14ComputedName.name");
    expect(inspect.stdout).not.toContain("gql:R14ComputedName");
    expect(inspect.stdout).toContain(
      "which is worked out when the class body runs",
    );
  });

  it("says the resolver behind a define_method field was not settled", () => {
    expect(inspect.stdout).toContain("gql:R15DefineMethod.value");
    expect(inspect.stdout).toContain(
      "defined with define_method, which this reader does not follow",
    );
  });

  for (const [typeName, reason] of UNREAD) {
    it(`reads no field for ${typeName}, because ${reason}`, () => {
      expect(inspect.stdout).not.toContain(typeName);
    });
  }

  it("reads the database call a resolver written inside an if makes", () => {
    expect(inspect.stdout).toContain("Campaign.find");
  });
});
