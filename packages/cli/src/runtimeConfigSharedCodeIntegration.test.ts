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

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

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
    expect(retry[0].sources).toEqual([
      expect.stringContaining("NotifierFunction"),
    ]);
  });

  it("places the shared module in both functions through their entries and reports nothing", async () => {
    // Both entries import the module, so it runs in both functions,
    // and its one read has a fallback, so nothing is wrong.
    const findings = await runPipeline();
    const fromShared = findings.filter((f) =>
      f.consumer.location.file.includes("config/logging"),
    );
    expect(fromShared).toEqual([]);
    expect(findings.filter((f) => f.description.includes("LOG_LEVEL"))).toEqual(
      [],
    );
  });

  it("charges a shared helper's read to the call that passed the name, not to every function that loads it", async () => {
    const findings = await runPipeline();
    const fromHelper = findings.filter((f) =>
      f.consumer.location.file.includes("config/env"),
    );
    expect(fromHelper).toEqual([]);
  });

  it("records the helper's own read with no name", async () => {
    const helper = (await extractCode()).find(
      (s) => s.identity.name === "requireEnv",
    );
    const reads = (helper?.transitions ?? [])
      .flatMap((t) => t.effects)
      .flatMap((e) =>
        e.type === "interaction" && e.interaction.class === "config-read"
          ? [{ name: e.interaction.name, callee: e.callee }]
          : [],
      );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.name === null)).toBe(true);
    expect(reads[0]?.callee).toBe("process.env[name]");
  });

  it("reads a constructor's default only in the handler whose `new` leaves the argument out", async () => {
    const code = await extractCode();
    const readsBy = (name: string) =>
      code
        .find((s) => s.identity.name === name)
        ?.transitions.flatMap((t) => t.effects)
        .flatMap((e) =>
          e.type === "interaction" && e.interaction.class === "config-read"
            ? [e.callee]
            : [],
        );
    expect(readsBy("IndexerFunction.handler")).toContain(
      "process.env.INDEX_TABLE_NAME",
    );
    expect(readsBy("NotifierFunction.handler")).not.toContain(
      "process.env.INDEX_TABLE_NAME",
    );
    expect(readsBy("IndexClient.constructor")).toEqual([]);
  });

  it("stops at a `new` whose class a table picks", async () => {
    const notifier = (await extractCode()).find(
      (s) => s.identity.name === "NotifierFunction.handler",
    );
    expect(notifier?.gaps.map((gap) => gap.description)).toEqual([
      expect.stringContaining("new Chosen"),
    ]);
  });

  it("does not call either function's declaration unused", async () => {
    const findings = await runPipeline();
    const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
    expect(unused.map((f) => f.description)).toEqual([]);
  });
});

async function runPipeline(): Promise<Finding[]> {
  const declared = cloudFormationFileToSummaries(
    path.join(fixtureRoot, "template.yaml"),
  );

  return checkAll([...(await extractCode()), ...declared]).findings;
}

async function extractCode(): Promise<BehavioralSummary[]> {
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
    const moduleImports = summary.metadata?.moduleImports;
    if (Array.isArray(moduleImports)) {
      summary.metadata = {
        ...summary.metadata,
        moduleImports: moduleImports.map((file) =>
          typeof file === "string" ? path.relative(fixtureRoot, file) : file,
        ),
      };
    }
  }
  return codeSummaries;
}
