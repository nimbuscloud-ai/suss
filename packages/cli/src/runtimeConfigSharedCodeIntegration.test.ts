// Two Lambdas built from one source directory, through the pipeline a
// user runs: extract with the aws-lambda pack and the node runtime
// pack, read the SAM template with the CloudFormation contract reader,
// then check.
//
// Both functions share a CodeUri, so the file path cannot say which
// function a handler runs in. Only the deployable unit each pack stamps
// can, and these tests hold it to that.

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

import type { Finding } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../fixtures/runtime-config-shared-code",
);

describe("runtime-config over two Lambdas on one CodeUri", () => {
  it("pairs each function's read against its own declaration", async () => {
    const findings = await runPipeline();
    const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");

    // Each function declares what its own handler reads, so neither
    // read is missing from the environment it runs in.
    expect(
      unknown.filter((f) => f.description.includes("INDEX_TABLE_NAME")),
    ).toEqual([]);
    expect(
      unknown.filter((f) => f.description.includes("NOTIFY_TOPIC_ARN")),
    ).toEqual([]);
  });

  it("gives a helper the unit of the handler it sits beside", async () => {
    const findings = await runPipeline();
    const fromHelper = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.consumer.location.exportName === "indexTable",
    );
    // The indexer's helper reads the indexer's variable, and the pack
    // stamps the handler in that module rather than the helper.
    expect(fromHelper).toEqual([]);
  });

  it("still reports a var no function declares", async () => {
    const findings = await runPipeline();
    const retry = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.description.includes("RETRY_LIMIT"),
    );

    // The notifier reads it and its own entry omits it, so one function
    // reports it and the indexer next door stays quiet.
    expect(retry).toHaveLength(1);
    expect(retry[0].severity).toBe("error");
    expect(retry[0].description).toContain("NotifierFunction");
  });

  it("reports the module neither function can claim once, and blames nothing", async () => {
    const findings = await runPipeline();
    const fromShared = findings.filter((f) =>
      f.consumer.location.file.includes("config/logging"),
    );
    expect(fromShared.map((f) => f.kind)).toEqual(["runtimeScopeUnknown"]);
    expect(fromShared[0].severity).toBe("info");
    expect(fromShared[0].description).toContain("2 runtimes");
    expect(findings.filter((f) => f.description.includes("LOG_LEVEL"))).toEqual(
      [],
    );
  });

  it("does not call either function's declaration unused", async () => {
    const findings = await runPipeline();
    const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
    expect(unused.map((f) => f.description)).toEqual([]);
  });
});

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

  const declared = cloudFormationFileToSummaries(
    path.join(fixtureRoot, "template.yaml"),
  );

  return checkAll([...codeSummaries, ...declared]).findings;
}
