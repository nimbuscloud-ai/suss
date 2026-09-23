/**
 * A queue worker, an HTTP function and a one-off script built from one
 * CodeUri, through the pipeline a user runs: extract, read the SAM
 * template, then check.
 *
 * The directory covers every file, so only the worker's handler entry,
 * followed through the module imports the adapter records, says which
 * POST a second delivery of a message repeats. The Python and Ruby
 * projects have no Lambda pack to stamp a deployable unit, so the entry
 * is all they have.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { webFetchPack } from "@suss/client-web";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import {
  awsLambdaFramework,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import faradayClient from "@suss/packs/faraday";
import requestsClient from "@suss/packs/requests";

import { relativizeSummaryPaths } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const typescriptRoot = path.join(fixtures, "queue-consumer-closure");
const pythonRoot = path.join(fixtures, "queue-consumer-closure-python");
const rubyRoot = path.join(fixtures, "queue-consumer-closure-ruby");

describe("repeat delivery over a queue worker on a shared CodeUri", () => {
  it("reports the TypeScript worker's own call and its helper's, and nothing else", async () => {
    clearTemplateCache();
    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(typescriptRoot, "tsconfig.json"),
      frameworks: [awsLambdaFramework(), webFetchPack()],
      cacheDir: null,
    });
    const code = await adapter.extractAll();
    for (const summary of code) {
      relativizeSummaryPaths(summary, typescriptRoot);
    }

    expect(repeatedCallFiles(code, typescriptRoot)).toEqual([
      "src/handlers/orders.ts",
      "src/lib/billing.ts",
    ]);
  });

  it("reports the Python worker's own call and its helper's, and nothing else", async () => {
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(pythonRoot),
      packs: [requestsClient()],
      roots: [pythonRoot],
      workspaceRoot: pythonRoot,
    });

    expect(repeatedCallFiles(summaries, pythonRoot)).toEqual([
      "src/handlers/orders.py",
      "src/lib/billing.py",
    ]);
  });

  it("reports the Ruby worker's own call and its helper's, and nothing else", async () => {
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(rubyRoot),
      packs: [faradayClient()],
      workspaceRoot: rubyRoot,
      cacheDir: null,
    });

    expect(repeatedCallFiles(summaries, rubyRoot)).toEqual([
      "src/handlers/orders.rb",
      "src/lib/billing.rb",
    ]);
  });
});

/** The files whose POST the check says a second delivery would repeat. */
function repeatedCallFiles(code: BehavioralSummary[], root: string): string[] {
  const declared = cloudFormationFileToSummaries(
    path.join(root, "template.yaml"),
  );
  return checkAll([...code, ...declared])
    .findings.filter((f) => f.kind === "repeatUnsafeConsumer")
    .map((f) => f.consumer.location.file)
    .sort();
}
