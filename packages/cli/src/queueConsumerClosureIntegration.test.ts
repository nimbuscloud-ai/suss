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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

const typescriptRoot = path.resolve(
  __dirname,
  "../../../fixtures/queue-consumer-closure",
);

describe("repeat delivery over a queue worker on a shared CodeUri", () => {
  let written: string | null = null;

  afterEach(() => {
    if (written !== null) {
      fs.rmSync(written, { recursive: true, force: true });
      written = null;
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
    // SAM spells a Python handler's module with dots.
    const root = writeProject("python3.12", "src.handlers", PYTHON_FILES);
    written = root;
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(root),
      packs: [requestsClient()],
      roots: [root],
      workspaceRoot: root,
    });

    expect(repeatedCallFiles(summaries, root)).toEqual([
      "src/handlers/orders.py",
      "src/lib/billing.py",
    ]);
  });

  it("reports the Ruby worker's own call and its helper's, and nothing else", async () => {
    const root = writeProject("ruby3.3", "src/handlers", RUBY_FILES);
    written = root;
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(root),
      packs: [faradayClient()],
      workspaceRoot: root,
      cacheDir: null,
    });

    expect(repeatedCallFiles(summaries, root)).toEqual([
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

/**
 * The same layout as the TypeScript fixture, in another language: a
 * worker that imports a billing helper, an HTTP handler and a script,
 * all under one CodeUri.
 */
function writeProject(
  runtime: string,
  handlerDirectory: string,
  files: Record<string, string>,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-queue-closure-"));
  const separator = handlerDirectory.includes("/") ? "/" : ".";
  const all = {
    ...files,
    "template.yaml": template(runtime, `${handlerDirectory}${separator}`),
  };
  for (const [file, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function template(runtime: string, handlerPrefix: string): string {
  return `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  OrdersQueue:
    Type: AWS::SQS::Queue
    Properties: {}
  OrdersWorker:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Runtime: ${runtime}
      Handler: ${handlerPrefix}orders.handler
      Events:
        FromOrders:
          Type: SQS
          Properties:
            Queue: !GetAtt OrdersQueue.Arn
  AccountsFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Runtime: ${runtime}
      Handler: ${handlerPrefix}accounts.handler
      Events:
        CreateAccount:
          Type: HttpApi
          Properties:
            Method: POST
            Path: /accounts
`;
}

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

const PYTHON_FILES: Record<string, string> = {
  "src/__init__.py": "",
  "src/handlers/__init__.py": "",
  "src/lib/__init__.py": "",
  "src/handlers/orders.py": lines(
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
  ),
  "src/lib/billing.py": lines(
    "import requests",
    "",
    "",
    "def charge_account(account):",
    '    return requests.post("https://billing.example.internal/v1/charges", json={"account": account})',
  ),
  "src/handlers/accounts.py": lines(
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
  ),
  "scripts/backfill.py": lines(
    "import requests",
    "",
    "",
    "def backfill_refund(refund_id):",
    '    return requests.post("https://billing.example.internal/v1/refunds", json={"id": refund_id})',
  ),
};

const RUBY_FILES: Record<string, string> = {
  Gemfile: lines(
    'source "https://rubygems.org"',
    "",
    'gem "faraday", "~> 2.0"',
  ),
  "src/handlers/orders.rb": lines(
    'require "json"',
    'require_relative "../lib/billing"',
    "",
    "def post_receipt(order_id)",
    '  Faraday.post("https://orders.example.internal/v1/receipts", { order_id: order_id }.to_json)',
    "end",
    "",
    "def handler(event:, context:)",
    '  event["Records"].each do |record|',
    '    order = JSON.parse(record["body"])',
    '    post_receipt(order["id"])',
    '    charge_account(order["account"])',
    "  end",
    "end",
  ),
  "src/lib/billing.rb": lines(
    "def charge_account(account)",
    '  Faraday.post("https://billing.example.internal/v1/charges", { account: account }.to_json)',
    "end",
  ),
  "src/handlers/accounts.rb": lines(
    "def create_account(body)",
    '  Faraday.post("https://accounts.example.internal/v1/accounts", body)',
    "end",
    "",
    "def handler(event:, context:)",
    '  create_account(event["body"])',
    "  { statusCode: 201 }",
    "end",
  ),
  "scripts/backfill.rb": lines(
    "def backfill_refund(refund_id)",
    '  Faraday.post("https://billing.example.internal/v1/refunds", { id: refund_id }.to_json)',
    "end",
  ),
};
