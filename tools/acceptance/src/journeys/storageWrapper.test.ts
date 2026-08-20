import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The two halves of grounding meet here. The adapter writes what a
 * storage layer was told, and the checker settles it against the call
 * site. Each half had a passing test of its own while the pair of them
 * agreed on nothing, so this journey runs both over one fixture.
 */
describe("check a storage layer that is told which table to read", () => {
  const summaries = workspace("storage-wrapper");
  const codeFile = path.join(summaries, "code.json");

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "--dir",
      fixture("storage-wrapper"),
      "-f",
      "aws-lambda",
      "-f",
      "aws-dynamodb",
      "-o",
      codeFile,
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("storage-wrapper"), "template.yaml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);
  });

  it("records the argument the table name comes out of, and the field", () => {
    const extracted = readJson(codeFile) as BehavioralSummary[];
    const containers = extracted.flatMap((summary) =>
      summary.transitions.flatMap((transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "interaction" &&
          effect.binding.semantics.name === "storage"
            ? [effect.binding.semantics.container]
            : [],
        ),
      ),
    );

    expect(containers).toEqual(["{location.table}"]);
  });

  it("pairs the access against the table its caller named", () => {
    const check = runSuss(["check", "--dir", summaries, "--all"]);

    expect(check.stdout).toContain(
      "aws.dynamodb:OrdersTable\n    cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable <-> storage-wrapper::src/orderStore.ts::readRow",
    );
  });

  it("reports the key the access picks rows by against that table", () => {
    const check = runSuss(["check", "--dir", summaries]);

    expect(check.status).toBe(1);
    expect(check.stdout).toContain(
      'readRow picks items on OrdersTable by "customerId", which is not one of its key attributes (orderId).',
    );
  });
});
