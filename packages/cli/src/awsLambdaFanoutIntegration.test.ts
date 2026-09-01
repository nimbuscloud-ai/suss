/**
 * Two Lambdas subscribed to one subject, through the pipeline a user
 * runs: extract the handlers with the aws-lambda pack, read the SAM
 * template with the CloudFormation contract reader, then pair.
 *
 * The two used to fan out. Both sides claimed `bus:aws_sqs
 * order.placed`, the subject was the whole key, and pairing crossed one
 * function's code with the other function's wiring. Only the template
 * says which queue delivers where, so only the template's side claims
 * the subject now, and what this pins is that nothing crosses.
 */

import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { pairSummaries } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import {
  awsLambdaFramework,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import { testCompilerOptions } from "@suss/test-project";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(__dirname, "../../../fixtures/aws-lambda");
const SHARED_SUBJECT_KEY = "bus:aws_sqs order.placed";

async function extractCode(): Promise<BehavioralSummary[]> {
  clearTemplateCache();
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { ...testCompilerOptions },
  });
  project.addSourceFilesAtPaths(path.join(fixtureRoot, "src/**/*.ts"));
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [awsLambdaFramework()],
  });
  return await adapter.extractAll();
}

function unitNameOf(summary: BehavioralSummary): string | undefined {
  return summary.identity.deployableUnit?.instanceName;
}

describe("aws-lambda fan-out on one subject", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    const code = await extractCode();
    const declared = cloudFormationFileToSummaries(
      path.join(fixtureRoot, "template.yaml"),
    );
    summaries = [...code, ...declared];
  });

  it("gives each subscription on the shared subject the Lambda it feeds", () => {
    const onSubject = summaries.filter((s) => {
      const semantics = s.identity.boundaryBinding?.semantics;
      return (
        semantics?.name === "message-bus" &&
        semantics.messageBus === "aws_sqs" &&
        semantics.channel !== null &&
        semantics.channel.endsWith("order.placed")
      );
    });

    // The template's two subscriptions, each recording its own Lambda.
    // The handlers are not here: their code cannot say which queue
    // reaches them, so it says the bus and leaves the channel blank.
    expect(onSubject.map(unitNameOf).sort()).toEqual([
      "OrderIndexerFunction",
      "OrderNotifierFunction",
    ]);
  });

  it("no longer joins one function's code to another function's wiring", () => {
    const pairs = pairSummaries(summaries).pairs.filter(
      (p) => p.key === SHARED_SUBJECT_KEY,
    );

    expect(pairs).toHaveLength(0);
  });

  it("keeps every handler's own Lambda on it", () => {
    const handlers = summaries.filter(
      (s) =>
        s.identity.name === "OrderIndexerFunction.handler" ||
        s.identity.name === "OrderNotifierFunction.handler",
    );

    expect(handlers.map(unitNameOf).sort()).toEqual([
      "OrderIndexerFunction",
      "OrderNotifierFunction",
    ]);
    // Which is what the queue a handler reads is looked up by, once
    // something wants the two halves of one Lambda together.
    for (const handler of handlers) {
      const semantics = handler.identity.boundaryBinding?.semantics;
      expect(semantics?.name).toBe("message-bus");
      if (semantics?.name === "message-bus") {
        expect(semantics.channel).toBeNull();
      }
    }
  });
});
