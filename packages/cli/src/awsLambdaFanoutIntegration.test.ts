// Two Lambdas answering one subject, through the pipeline a user runs:
// extract the handlers with the aws-lambda pack, read the SAM template
// with the CloudFormation contract reader, then pair.
//
// Both packs now name the Lambda each summary belongs to, which is what
// this pins. Pairing does not read that field yet, so the shared subject
// still produces every handler against every subscription. The fan-out
// is asserted here so the count is on record and the change that fixes
// it has something to move.

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
const SHARED_SUBJECT_KEY = "bus:sqs order.placed";

async function extractCode(): Promise<BehavioralSummary[]> {
  clearTemplateCache();
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { ...testCompilerOptions },
  });
  project.addSourceFilesAtPaths(path.join(fixtureRoot, "src/**/*.ts"));
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [
      awsLambdaFramework({
        // The fixture service owns this factory, so the pack only reads
        // the subject once the service names it, the way a project does
        // through `-f aws-lambda=config.json`.
        subjectFactories: [{ property: "subject" }],
      }),
    ],
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

  it("gives each side of the shared subject the Lambda it runs in", () => {
    const onSubject = summaries.filter((s) => {
      const semantics = s.identity.boundaryBinding?.semantics;
      return (
        semantics?.name === "message-bus" &&
        semantics.messageBus === "sqs" &&
        semantics.channel.endsWith("order.placed")
      );
    });

    // Two handlers in code, two subscriptions in the template. Each
    // names its own Lambda, and the two packs that say so never talk to
    // each other.
    expect(onSubject.map(unitNameOf).sort()).toEqual([
      "OrderIndexerFunction",
      "OrderIndexerFunction",
      "OrderNotifierFunction",
      "OrderNotifierFunction",
    ]);
  });

  it("still pairs every handler against every subscription", () => {
    const pairs = pairSummaries(summaries).pairs.filter(
      (p) => p.key === SHARED_SUBJECT_KEY,
    );

    // Four combinations, because the subject is the whole key. Two of
    // them join one function's code to another function's wiring, which
    // states nothing about either.
    expect(pairs).toHaveLength(4);
    const crossed = pairs.filter(
      (p) => unitNameOf(p.provider) !== unitNameOf(p.consumer),
    );
    expect(crossed).toHaveLength(2);
  });
});
