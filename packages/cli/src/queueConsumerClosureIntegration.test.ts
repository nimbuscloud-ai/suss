/**
 * A queue worker, an HTTP function and a one-off script built from one
 * CodeUri, through the pipeline a user runs: extract, read the SAM
 * template, then check.
 *
 * The directory covers every file, so only the worker's handler entry,
 * followed through the module imports the adapter records, says which
 * POST a second delivery of a message repeats, with or without the
 * Lambda pack that stamps each handler's deployable unit.
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
  awsLambdaPython as lambdaPython,
  awsLambdaRuby as lambdaRuby,
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
    for (const packs of [
      [requestsClient()],
      [requestsClient(), lambdaPython()],
    ]) {
      clearTemplateCache();
      const { summaries } = await extractPythonProject({
        files: findPythonFiles(pythonRoot),
        packs,
        roots: [pythonRoot],
        workspaceRoot: pythonRoot,
      });

      expect(repeatedCallFiles(summaries, pythonRoot)).toEqual([
        "src/handlers/orders.py",
        "src/lib/billing.py",
      ]);
    }
  });

  it("reports the Ruby worker's own call and its helper's, and nothing else", async () => {
    for (const packs of [[faradayClient()], [faradayClient(), lambdaRuby()]]) {
      clearTemplateCache();
      const { summaries } = await extractRubyProject({
        files: findRubyFiles(rubyRoot),
        packs,
        workspaceRoot: rubyRoot,
        cacheDir: null,
      });

      expect(repeatedCallFiles(summaries, rubyRoot)).toEqual([
        "src/handlers/orders.rb",
        "src/lib/billing.rb",
      ]);
    }
  });

  it("starts a Python summary at each handler the template points at, the dotted module included", async () => {
    clearTemplateCache();
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(pythonRoot),
      packs: [lambdaPython()],
      roots: [pythonRoot],
      workspaceRoot: pythonRoot,
    });

    expect(handlerStarts(summaries)).toEqual([
      "AccountsFunction src/handlers/accounts.py handler",
      "OrdersWorker src/handlers/orders.py handler",
    ]);
  });

  it("starts a Ruby summary at each handler, a namespaced class method included", async () => {
    clearTemplateCache();
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(rubyRoot),
      packs: [lambdaRuby()],
      workspaceRoot: rubyRoot,
      cacheDir: null,
    });

    expect(handlerStarts(summaries)).toEqual([
      "AccountsFunction src/handlers/accounts.rb handler",
      "OrdersWorker src/handlers/orders.rb handler",
      "ReportsFunction src/handlers/reports.rb Reports::Nightly.run",
    ]);
  });

  it("records the function the template calls next to the file it enters", () => {
    const scopes = cloudFormationFileToSummaries(
      path.join(rubyRoot, "template.yaml"),
    )
      .map((summary) => summary.metadata?.codeScope)
      .filter((scope) => scope !== undefined);

    expect(scopes).toContainEqual(
      expect.objectContaining({
        entry: "src/handlers/reports",
        entryExport: "Reports::Nightly.run",
      }),
    );
  });
});

/** Each handler with a deployable unit, as `<unit> <file> <export path>`. */
function handlerStarts(code: BehavioralSummary[]): string[] {
  return code
    .flatMap((summary) => {
      const unit = summary.identity.deployableUnit;
      return unit === undefined
        ? []
        : [
            `${unit.instanceName} ${summary.location.file} ${(summary.identity.exportPath ?? []).join(".")}`,
          ];
    })
    .sort();
}

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
