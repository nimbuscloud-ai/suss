import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * A job a container or a scheduled task runs has no handler. It opens a
 * pool and runs its queries in top-level statements, so nothing pack
 * discovery looks for is there, and the functions doing the work are
 * private to their files. Module scope is what reaches them.
 */
describe("read a job that does its work while the module loads", () => {
  const summaries = workspace("typescript-job");
  const codeFile = path.join(summaries, "code.json");
  let extracted: BehavioralSummary[] = [];

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "--dir",
      fixture("typescript-job"),
      "-f",
      "pg",
      "-o",
      codeFile,
    ]);
    expect(code.status, code.stderr).toBe(0);
    extracted = readJson(codeFile) as BehavioralSummary[];
  });

  function tablesIn(name: string): string[] {
    return extracted
      .filter((summary) => summary.identity.name === name)
      .flatMap((summary) => summary.transitions)
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.binding.semantics.name === "storage"
          ? [effect.binding.semantics.container ?? ""]
          : [],
      );
  }

  function callsFrom(name: string): string[] {
    return extracted
      .filter((summary) => summary.identity.name === name)
      .flatMap((summary) => summary.transitions)
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "invocation" && effect.summary !== undefined
          ? [effect.summary]
          : [],
      );
  }

  it("reports the queries the functions a job calls at load time run", () => {
    expect(tablesIn("syncAccounts")).toEqual(["dim_account"]);
    expect(tablesIn("pruneAccounts")).toEqual(["dim_account"]);
    expect(tablesIn("main")).toEqual(["report_totals"]);
  });

  it("says on the job's own unit which of its functions it calls", () => {
    expect(callsFrom("syncJob.ts")).toEqual(
      expect.arrayContaining([
        "typescript-job::src/syncJob.ts::syncAccounts",
        "typescript-job::src/syncJob.ts::pruneAccounts",
      ]),
    );
    expect(callsFrom("reportJob.ts")).toEqual([
      "typescript-job::src/reportJob.ts::main",
    ]);
  });

  it("reports a query inside a function the job invokes on the spot as the module's own", () => {
    expect(tablesIn("backfillJob.ts").sort()).toEqual([
      "dim_account",
      "staging_account",
    ]);
  });
});
