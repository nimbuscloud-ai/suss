import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearTemplateCache, lambdaEntryPoints } from "./index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-lambda-entry-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  clearTemplateCache();
  write(
    "sam/template.yaml",
    `
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Runtime: python3.12
      Handler: jobs.worker.handler
      Events:
        Queue:
          Type: SQS
          Properties: { Queue: arn:aws:sqs:us-east-1:000000000000:jobs }
  Billing:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Runtime: ruby3.3
      Handler: app/billing.Billing::Handler.process
      Events:
        Charge:
          Type: HttpApi
          Properties: { Method: POST, Path: /charges }
`,
  );
  write("sam/jobs/worker.py", "def handler(event, context):\n  pass\n");
  write("sam/app/billing.rb", "module Billing\nend\n");
  write(
    "service/serverless.yml",
    `
service: tickets
provider:
  name: aws
  runtime: ruby3.3
functions:
  buy-ticket:
    handler: src/handlers/buy.run
`,
  );
  write("service/src/handlers/buy.rb", "def run(event:, context:)\nend\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearTemplateCache();
});

const entryPoints = lambdaEntryPoints("aws-lambda-test");

describe("lambdaEntryPoints", () => {
  it("finds a Python handler whose module the template writes with dots", () => {
    const [entry] = entryPoints(path.join(root, "sam/jobs/worker.py"));

    expect(entry?.name).toBe("handler");
    expect(entry?.units).toEqual([
      expect.objectContaining({
        kind: "handler",
        name: "Worker.handler",
        deployableUnit: { deploymentTarget: "lambda", instanceName: "Worker" },
        binding: expect.objectContaining({
          semantics: expect.objectContaining({
            name: "message-bus",
            messageBus: "aws_sqs",
          }),
        }),
      }),
    ]);
  });

  it("finds a Ruby class method and binds a route handler as the deployed function", () => {
    const [entry] = entryPoints(path.join(root, "sam/app/billing.rb"));

    expect(entry?.name).toBe("Billing::Handler.process");
    expect(entry?.units[0]?.binding.recognition).toBe("aws-lambda-test");
    expect(entry?.units[0]?.binding.semantics).toEqual({
      name: "unit-invocation",
      deploymentTarget: "lambda",
      instanceName: "Billing",
    });
    expect(entry?.units[0]?.metadata).toEqual({
      awsLambda: {
        handler: "app/billing.Billing::Handler.process",
        recognition: "handler-entry",
        eventTypes: ["HttpApi"],
      },
    });
  });

  it("reads a Serverless Framework service file the way it reads a SAM template", () => {
    const entries = entryPoints(path.join(root, "service/src/handlers/buy.rb"));

    expect(entries.map((entry) => entry.name)).toEqual(["run"]);
    expect(entries[0]?.units[0]?.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "buy-ticket",
    });
  });

  it("finds nothing in a file no template points at", () => {
    expect(entryPoints(path.join(root, "sam/jobs/other.py"))).toEqual([]);
  });
});
