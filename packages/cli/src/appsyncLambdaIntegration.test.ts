/**
 * An AppSync API that routes one field to a Lambda in each language,
 * read from both sides: the handler through its adapter and the Lambda
 * pack, the template through the AppSync contract. For each field the
 * two summaries should state the same boundary, transport included, so
 * a reader of either sees one boundary and not two.
 */

import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { appsyncFileToSummaries } from "@suss/contract-appsync";
import {
  awsLambdaFramework,
  awsLambdaPython,
  awsLambdaRuby,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(__dirname, "../../../fixtures/appsync-lambda");

async function typescriptSummaries(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    frameworks: [awsLambdaFramework()],
    cacheDir: null,
  });
  return adapter.extractAll();
}

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [awsLambdaPython()],
    roots: [root],
    workspaceRoot: root,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [awsLambdaRuby()],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

/** The binding a summary states for a field, without who recognized it. */
function fieldBinding(summaries: BehavioralSummary[], field: string) {
  const [typeName, fieldName] = field.split(".");
  const binding = summaries
    .map((summary) => summary.identity.boundaryBinding)
    .find(
      (candidate) =>
        candidate?.semantics.name === "graphql-resolver" &&
        candidate.semantics.typeName === typeName &&
        candidate.semantics.fieldName === fieldName,
    );
  if (binding === undefined || binding === null) {
    return null;
  }
  return { transport: binding.transport, semantics: binding.semantics };
}

const contract = appsyncFileToSummaries(path.join(root, "template.yaml"));

function expectSameBoundary(code: BehavioralSummary[], field: string): void {
  expect(fieldBinding(contract, field)).not.toBeNull();
  expect(fieldBinding(code, field)).toEqual(fieldBinding(contract, field));
}

describe("an AppSync field routed to a Lambda", () => {
  beforeEach(() => {
    clearTemplateCache();
  });

  it("states the same boundary from a TypeScript handler as from the template", async () => {
    expectSameBoundary(await typescriptSummaries(), "Query.note");
  });

  it("states the same boundary from a Python handler as from the template", async () => {
    expectSameBoundary(await pythonSummaries(), "Query.search");
  });

  it("states the same boundary from a Ruby handler as from the template", async () => {
    expectSameBoundary(await rubySummaries(), "Mutation.addNote");
  });
});
