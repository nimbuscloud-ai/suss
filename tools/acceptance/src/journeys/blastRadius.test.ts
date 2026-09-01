import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

/**
 * Which boundaries end up going through one store.
 *
 * The question a person asks before changing a table is which of the
 * things their users touch behave differently afterwards, so the answer
 * is routes and queues rather than the functions in between.
 */
describe("what reaches a store", () => {
  const summaries = workspace("blast-radius");

  beforeAll(() => {
    const run = runSuss([
      "extract",
      "--dir",
      fixture("queue-consumer-store"),
      "-f",
      "aws-lambda",
      "-f",
      "aws-dynamodb",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(run.status, run.stderr).toBe(0);
  }, 120_000);

  const ask = (question: string) =>
    runSuss(["ask", question, "--dir", summaries]);

  it("names the route and the queue that both write the table", () => {
    const run = ask("what reaches aws.dynamodb:Invoices");

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("2 boundaries reach aws.dynamodb:Invoices");
    expect(run.stdout).toContain("GET /invoices/{invoiceId}");
    expect(run.stdout).toContain("bus:aws_sqs");
  });

  it("says a caller may be missing when a call resolved to no unit", () => {
    const run = ask("what reaches aws.dynamodb:Invoices");

    expect(run.stdout).toContain("resolved to no unit");
  });
});
