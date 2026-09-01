import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { copyOfFixture, readJson, runSuss } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * Wire a Lambda to something else in the SAM template and run extract
 * again. Nothing under `src` changed, so every source file hashes the
 * same and the run has to notice the template instead.
 *
 * The answer this journey watches is which bus reaches the handler. The
 * fixture's worker is behind a queue; after the edit it is behind a
 * schedule, which is a different bus, and a run that hands back the
 * queue is describing a service that no longer exists.
 */
describe("extract after the template changed and nothing else did", () => {
  const project = copyOfFixture("queue-consumer-store", "template-edit");
  const template = path.join(project, "template.yaml");
  const codeFile = path.join(project, "code.json");

  const extract = (): { output: string; wires: string[] } => {
    const run = runSuss([
      "extract",
      "--dir",
      project,
      "-f",
      "aws-lambda",
      "--timing",
      "-o",
      codeFile,
    ]);
    expect(run.status, run.stderr).toBe(0);
    const summaries = readJson(codeFile) as BehavioralSummary[];
    return {
      output: run.output,
      wires: summaries.flatMap((summary) => {
        const semantics = summary.identity.boundaryBinding?.semantics;
        return semantics?.name === "message-bus" ? [semantics.messageBus] : [];
      }),
    };
  };

  beforeAll(() => {
    expect(extract().wires).toEqual(["aws_sqs"]);

    fs.writeFileSync(
      template,
      fs
        .readFileSync(template, "utf8")
        .replace(
          [
            "        FromInvoices:",
            "          Type: SQS",
            "          Properties:",
            "            Queue: !GetAtt InvoicesQueue.Arn",
          ].join("\n"),
          [
            "        Nightly:",
            "          Type: Schedule",
            "          Properties:",
            "            Schedule: rate(5 minutes)",
          ].join("\n"),
        ),
    );
  }, 120_000);

  it("says which bus the template names now, not the one it named before", () => {
    expect(extract().wires).toEqual(["eventbridge"]);
  });

  it("still hands back the previous run when the template stayed put", () => {
    extract();
    const again = extract();

    expect(again.output).toContain("cache: hit");
    expect(again.wires).toEqual(["eventbridge"]);
  });
});
