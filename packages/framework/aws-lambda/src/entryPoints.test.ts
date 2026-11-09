import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bindingOfDiscoveredUnit } from "@suss/extractor";

import {
  awsLambdaPython,
  awsLambdaRuby,
  clearTemplateCache,
  pythonHandlerEntries,
  rubyHandlerEntries,
} from "./index.js";

import type { UnitSpec } from "@suss/extractor";

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
  write(
    "graphql/template.yaml",
    `
Transform: AWS::Serverless-2016-10-31
Resources:
  NotesApi:
    Type: AWS::AppSync::GraphQLApi
    Properties: { Name: notes, AuthenticationType: API_KEY }
  NotesDataSource:
    Type: AWS::AppSync::DataSource
    Properties:
      ApiId: !GetAtt NotesApi.ApiId
      Name: NotesLambda
      Type: AWS_LAMBDA
      LambdaConfig:
        LambdaFunctionArn: !GetAtt NotesFunction.Arn
  QueryNoteResolver:
    Type: AWS::AppSync::Resolver
    Properties:
      ApiId: !GetAtt NotesApi.ApiId
      TypeName: Query
      FieldName: note
      DataSourceName: !GetAtt NotesDataSource.Name
  NotesFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Runtime: python3.12
      Handler: notes.handler
`,
  );
  write("graphql/notes.py", "def handler(event, context):\n  pass\n");
  write(
    "graphql-mixed/template.yaml",
    `
Transform: AWS::Serverless-2016-10-31
Resources:
  NotesApi:
    Type: AWS::AppSync::GraphQLApi
    Properties: { Name: notes, AuthenticationType: API_KEY }
  NotesDataSource:
    Type: AWS::AppSync::DataSource
    Properties:
      ApiId: !GetAtt NotesApi.ApiId
      Name: NotesLambda
      Type: AWS_LAMBDA
      LambdaConfig:
        LambdaFunctionArn: !GetAtt NotesFunction.Arn
  QueryNoteResolver:
    Type: AWS::AppSync::Resolver
    Properties:
      ApiId: !GetAtt NotesApi.ApiId
      TypeName: Query
      FieldName: note
      DataSourceName: NotesLambda
  Jobs:
    Type: AWS::SQS::Queue
  NotesFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Runtime: python3.12
      Handler: notes.handler
      Events:
        FromJobs:
          Type: SQS
          Properties: { Queue: !GetAtt Jobs.Arn }
`,
  );
  write("graphql-mixed/notes.py", "def handler(event, context):\n  pass\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearTemplateCache();
});

const entryPoints = pythonHandlerEntries;

/** The binding the adapter builds for a unit spec, under the test's pack name. */
function boundAs(unit: UnitSpec | undefined) {
  return unit === undefined
    ? null
    : bindingOfDiscoveredUnit(unit, {
        name: "aws-lambda-test",
        protocol: "http",
      });
}

describe("the Python and Ruby packs", () => {
  it("hand each adapter one manifest pattern over the handlers in a file", () => {
    const file = path.join(root, "sam/jobs/worker.py");
    for (const pack of [awsLambdaPython(), awsLambdaRuby()]) {
      const [pattern] = pack.declaredDiscovery ?? [];
      const entries =
        pattern?.match.type === "manifest" ? pattern.match.entries(file) : [];
      expect(pattern?.kind).toBe("handler");
      expect(entries[0]?.path).toEqual(["handler"]);
      expect(pack.version).toBe("1");
      expect(pack.discoveryInputs?.([file])).toEqual([
        path.join(root, "sam/template.yaml"),
      ]);
    }
    expect(awsLambdaPython().libraryEnvVars).toEqual([
      { module: "aws_lambda_powertools", prefixes: ["POWERTOOLS_"] },
    ]);
  });
});

describe("the Python and Ruby handler entries", () => {
  it("binds a handler AppSync routes a field to as that field's resolver, over aws-https", () => {
    const [entry] = entryPoints(path.join(root, "graphql/notes.py"));

    expect(entry?.units).toHaveLength(1);
    expect(boundAs(entry?.units[0])).toMatchObject({
      transport: "aws-https",
      semantics: {
        name: "graphql-resolver",
        typeName: "Query",
        fieldName: "note",
      },
    });
    expect(entry?.units[0]?.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "NotesFunction",
    });
    expect(entry?.units[0]?.metadata).toEqual({
      awsLambda: { handler: "notes.handler", recognition: "appsync-resolver" },
    });
  });

  it("keeps a unit for a queue that also reaches a handler serving a field", () => {
    const [entry] = entryPoints(path.join(root, "graphql-mixed/notes.py"));

    expect(entry?.units.map((unit) => boundAs(unit)?.semantics.name)).toEqual([
      "graphql-resolver",
      "unit-invocation",
    ]);
  });

  it("finds a Python handler whose module the template writes with dots", () => {
    const [entry] = entryPoints(path.join(root, "sam/jobs/worker.py"));

    expect(entry?.path).toEqual(["handler"]);
    expect(entry?.units).toEqual([
      expect.objectContaining({
        kind: "handler",
        name: "Worker.handler",
        deployableUnit: { deploymentTarget: "lambda", instanceName: "Worker" },
        channelInfo: { messageBus: "aws_sqs", channel: null },
      }),
    ]);
  });

  it("finds a Ruby class method through its class's constant path, and binds a route handler as the deployed function", () => {
    const [entry] = rubyHandlerEntries(path.join(root, "sam/app/billing.rb"));

    expect(entry?.path).toEqual(["Billing", "Handler"]);
    expect(entry?.member).toEqual({ name: "process", singleton: true });
    expect(boundAs(entry?.units[0])?.recognition).toBe("aws-lambda-test");
    expect(boundAs(entry?.units[0])?.semantics).toEqual({
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
    const entries = rubyHandlerEntries(
      path.join(root, "service/src/handlers/buy.rb"),
    );

    expect(entries.map((entry) => entry.path)).toEqual([["run"]]);
    expect(entries[0]?.units[0]?.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "buy-ticket",
    });
  });

  it("finds nothing in a file no template points at", () => {
    expect(entryPoints(path.join(root, "sam/jobs/other.py"))).toEqual([]);
  });
});
