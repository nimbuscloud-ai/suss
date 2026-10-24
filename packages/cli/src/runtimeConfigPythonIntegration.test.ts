/**
 * Two Python Lambdas built from one source directory, through the
 * pipeline a user runs: extract with the FastAPI pack, read the SAM
 * template with the CloudFormation contract reader, then check.
 *
 * The Python adapter has no Lambda pack to stamp a deployable unit, so
 * the only thing that says which module runs where is each function's
 * handler entry, followed through the module imports the adapter
 * stamps.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import {
  awsLambdaPython,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import { fastapiFramework } from "@suss/framework-fastapi";

import type { PythonPack } from "@suss/adapter-python";
import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../fixtures/runtime-config-python",
);

describe("runtime-config over two Python Lambdas on one CodeUri", () => {
  it("reports a route's read of a variable no function declares, spelled the way Python wrote it", async () => {
    const findings = await runPipeline();
    const bucket = findings.filter(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.description.includes("ASSET_BUCKET"),
    );

    expect(bucket).toHaveLength(1);
    expect(bucket[0].severity).toBe("error");
    expect(bucket[0].description).toContain('os.environ["ASSET_BUCKET"]');
    expect(bucket[0].sources).toEqual([expect.stringContaining("ApiFunction")]);
    expect(bucket[0].consumer.location.file).toBe("src/app.py");
  });

  it("pairs each module's load-time read against the function whose entry loads it", async () => {
    const findings = await runPipeline();
    expect(
      findings.filter(
        (f) =>
          f.description.includes("TABLE_NAME") ||
          f.description.includes("QUEUE_URL"),
      ),
    ).toEqual([]);
  });

  it("places an imported module through the entry and accepts its defaulted read", async () => {
    const findings = await runPipeline();
    expect(findings.filter((f) => f.description.includes("PAGE_SIZE"))).toEqual(
      [],
    );
  });

  it("reports the variable a function declares and nothing in its closure reads", async () => {
    const findings = await runPipeline();
    const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
    expect(unused).toHaveLength(1);
    expect(unused[0].description).toContain("RETRY_LIMIT");
  });

  it("charges a shared helper's read to the call that passed the name", async () => {
    const findings = await runPipeline();
    expect(
      findings.filter((f) => f.consumer.location.file === "src/env.py"),
    ).toEqual([]);
  });

  it("links building a class to its __init__, which keeps its own read", async () => {
    const code = await extractCode([awsLambdaPython()]);
    const worker = code.find(
      (s) => s.identity.name === "WorkerFunction.handler",
    );
    const built = worker?.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "QueueClient");
    const init = code.find(
      (s) => built?.type === "invocation" && s.identity.id === built.summary,
    );
    expect(init?.identity.name).toBe("__init__");
    expect(configReadsOf(init)).toEqual([
      { name: "QUEUE_URL", callee: 'os.environ["QUEUE_URL"]' },
    ]);
  });

  it("records the helper's own read with no name", async () => {
    const helper = (await extractCode()).find(
      (s) => s.identity.name === "require_env",
    );
    expect(configReadsOf(helper)).toEqual([
      { name: null, callee: "os.environ[name]" },
    ]);
  });
});

async function runPipeline(): Promise<Finding[]> {
  const declared = cloudFormationFileToSummaries(
    path.join(fixtureRoot, "template.yaml"),
  );

  return checkAll([...(await extractCode()), ...declared]).findings;
}

async function extractCode(
  morePacks: PythonPack[] = [],
): Promise<BehavioralSummary[]> {
  const sourceRoot = path.join(fixtureRoot, "src");
  clearTemplateCache();
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(sourceRoot),
    packs: [fastapiFramework(), ...morePacks],
    roots: [sourceRoot],
    workspaceRoot: fixtureRoot,
  });
  return summaries;
}

/** Each config read on a summary, as its name and how the code wrote it. */
function configReadsOf(
  summary: BehavioralSummary | undefined,
): Array<{ name: string | null; callee: string | undefined }> {
  return (summary?.transitions ?? [])
    .flatMap((t) => t.effects)
    .flatMap((e) =>
      e.type === "interaction" && e.interaction.class === "config-read"
        ? [{ name: e.interaction.name, callee: e.callee }]
        : [],
    );
}
