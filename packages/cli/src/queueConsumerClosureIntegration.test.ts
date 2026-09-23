/**
 * A queue worker, an HTTP function and a one-off script built from one
 * CodeUri, through the pipeline a user runs: extract, read the SAM
 * template, then check.
 *
 * The directory covers every file, so only the worker's handler entry,
 * followed through the module imports the adapter records, says which
 * POST a second delivery of a message repeats. The Python project has
 * no Lambda pack to stamp a deployable unit, so the entry is all it has.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { webFetchPack } from "@suss/client-web";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import {
  awsLambdaFramework,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import requestsClient from "@suss/packs/requests";

import { relativizeSummaryPaths } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const typescriptRoot = path.resolve(
  __dirname,
  "../../../fixtures/queue-consumer-closure",
);

describe("repeat delivery over a queue worker on a shared CodeUri", () => {
  let pythonRoot: string | null = null;

  afterEach(() => {
    if (pythonRoot !== null) {
      fs.rmSync(pythonRoot, { recursive: true, force: true });
      pythonRoot = null;
    }
  });

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
    pythonRoot = writePythonProject();
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

/**
 * The same layout in Python, with the handlers written the way SAM
 * spells a Python module, dots and all.
 */
function writePythonProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-queue-closure-"));
  const files: Record<string, string> = {
    "template.yaml": PYTHON_TEMPLATE,
    "src/__init__.py": "",
    "src/handlers/__init__.py": "",
    "src/lib/__init__.py": "",
    "src/handlers/orders.py": [
      "import json",
      "",
      "import requests",
      "",
      "from src.lib.billing import charge_account",
      "",
      "",
      "def post_receipt(order_id):",
      '    return requests.post("https://orders.example.internal/v1/receipts", json={"order_id": order_id})',
      "",
      "",
      "def handler(event, context):",
      '    for record in event["Records"]:',
      '        order = json.loads(record["body"])',
      '        post_receipt(order["id"])',
      '        charge_account(order["account"])',
      "",
    ].join("\n"),
    "src/lib/billing.py": [
      "import requests",
      "",
      "",
      "def charge_account(account):",
      '    return requests.post("https://billing.example.internal/v1/charges", json={"account": account})',
      "",
    ].join("\n"),
    "src/handlers/accounts.py": [
      "import requests",
      "",
      "",
      "def create_account(body):",
      '    return requests.post("https://accounts.example.internal/v1/accounts", data=body)',
      "",
      "",
      "def handler(event, context):",
      '    create_account(event["body"])',
      '    return {"statusCode": 201}',
      "",
    ].join("\n"),
    "scripts/backfill.py": [
      "import requests",
      "",
      "",
      "def backfill_refund(refund_id):",
      '    return requests.post("https://billing.example.internal/v1/refunds", json={"id": refund_id})',
      "",
    ].join("\n"),
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const PYTHON_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  OrdersQueue:
    Type: AWS::SQS::Queue
    Properties: {}
  OrdersWorker:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Runtime: python3.12
      Handler: src.handlers.orders.handler
      Events:
        FromOrders:
          Type: SQS
          Properties:
            Queue: !GetAtt OrdersQueue.Arn
  AccountsFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Runtime: python3.12
      Handler: src.handlers.accounts.handler
      Events:
        CreateAccount:
          Type: HttpApi
          Properties:
            Method: POST
            Path: /accounts
`;
