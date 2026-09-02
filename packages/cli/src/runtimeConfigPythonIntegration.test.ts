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
import { fastapiFramework } from "@suss/framework-fastapi";

import type { Finding } from "@suss/behavioral-ir";

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
    expect(bucket[0].description).toContain("ApiFunction");
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
});

async function runPipeline(): Promise<Finding[]> {
  const sourceRoot = path.join(fixtureRoot, "src");
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(sourceRoot),
    packs: [fastapiFramework()],
    roots: [sourceRoot],
    workspaceRoot: fixtureRoot,
  });

  const declared = cloudFormationFileToSummaries(
    path.join(fixtureRoot, "template.yaml"),
  );

  return checkAll([...summaries, ...declared]).findings;
}
