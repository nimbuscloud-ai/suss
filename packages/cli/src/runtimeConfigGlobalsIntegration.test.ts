// A service that declares most of its environment once, in the SAM
// Globals section, through the pipeline a user runs: extract with the
// aws-lambda pack and the node runtime pack, read the SAM template with
// the CloudFormation contract reader, then check.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import {
  awsLambdaFramework,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import { nodeRuntimePack } from "@suss/runtime-node";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../fixtures/runtime-config-globals",
);

const templatePath = path.join(fixtureRoot, "template.yaml");

describe("runtime-config over a template with a Globals section", () => {
  it("counts a variable the section declares as declared", async () => {
    const findings = await runPipeline();
    const logLevel = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.description.includes("LOG_LEVEL"),
    );
    expect(logLevel).toEqual([]);
  });

  it("gives the function's own value where both declare the variable", () => {
    const declared = cloudFormationFileToSummaries(templatePath);
    const ingest = declared.find((s) => s.identity.name === "IngestFunction");
    expect(readEnvVarTargets(ingest).TABLE_NAME).toEqual({
      kind: "ref",
      logicalId: "IngestTable",
    });
  });

  it("stays quiet about a section variable the other function reads", async () => {
    const findings = await runPipeline();
    const logLevel = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnused" && f.description.includes("LOG_LEVEL"),
    );
    expect(logLevel).toEqual([]);
  });

  it("reports once a section variable no function reads", async () => {
    const findings = await runPipeline();
    const sentry = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnused" &&
        f.description.includes("SENTRY_DSN"),
    );
    expect(sentry).toHaveLength(1);
    expect(sentry[0].severity).toBe("warning");
  });

  it("still reports a variable neither place declares", async () => {
    const findings = await runPipeline();
    const retry = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.description.includes("RETRY_LIMIT"),
    );
    expect(retry).toHaveLength(1);
    expect(retry[0].severity).toBe("error");
    expect(retry[0].description).toContain("IngestFunction");
  });
});

function readEnvVarTargets(
  summary: BehavioralSummary | undefined,
): Record<string, { kind: string; logicalId: string }> {
  const contract = summary?.metadata?.runtimeContract as
    | { envVarTargets?: Record<string, { kind: string; logicalId: string }> }
    | undefined;
  return contract?.envVarTargets ?? {};
}

async function runPipeline(): Promise<Finding[]> {
  clearTemplateCache();
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [awsLambdaFramework(), nodeRuntimePack()],
    cacheDir: null,
  });
  const codeSummaries = await adapter.extractAll();
  // The adapter records absolute paths; the CLI rewrites them to
  // project-relative before publishing, and the SAM CodeUri is
  // relative, so do the same here.
  for (const summary of codeSummaries) {
    summary.location.file = path.relative(fixtureRoot, summary.location.file);
  }

  const declared = cloudFormationFileToSummaries(templatePath);

  return checkAll([...codeSummaries, ...declared]).findings;
}
