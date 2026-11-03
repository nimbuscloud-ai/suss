/**
 * A dependency stub through the extract a user runs: the stub the
 * teach-a-dependency guide shows, a stub in a shape no pack reads, and a
 * stub drafted by `suss infer stub` with its blanks filled in.
 *
 * The guide's stub is the one in the aws-stub-producer fixture, so the
 * fixture and the guide cannot say different things.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extract } from "./extract.js";
import { stubDraft } from "./stubDraftCommand.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixture = path.resolve(__dirname, "../../../fixtures/aws-stub-producer");

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

async function summariesOf(tsconfig: string): Promise<BehavioralSummary[]> {
  return await extract({
    tsconfig,
    frameworks: ["aws-lambda", "aws-sqs"],
    output: path.join(tempDir("suss-stub-out-"), "summaries.json"),
    noCache: true,
    quiet: true,
  });
}

/** Each unit's sends, as `channel via callee`, keyed by the unit's name. */
function sendsByUnit(summaries: BehavioralSummary[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const summary of summaries) {
    const sends = summary.transitions
      .flatMap((transition) => transition.effects)
      .flatMap((effect) => {
        if (
          effect.type !== "interaction" ||
          effect.interaction.class !== "message-send" ||
          effect.binding.semantics.name !== "message-bus"
        ) {
          return [];
        }
        return [`${effect.binding.semantics.channel} via ${effect.callee}`];
      });
    found[summary.identity.name] = [...new Set(sends)];
  }
  return found;
}

const HANDLER = `import { publishEntry } from "@acme/ledger-native";

export const handler = async (event: { body: string }) => {
  await publishEntry("ledger-queue", JSON.parse(event.body));
  return { statusCode: 201, body: "" };
};
`;

const TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  RecordEntry:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./src/
      Handler: handlers/recordEntry.handler
      Runtime: nodejs20.x
      Events:
        Record:
          Type: Api
          Properties:
            Path: /ledger
            Method: post
`;

/** A Lambda project that calls the native package, with the stub given, or none. */
function ledgerProject(stub?: string): string {
  const root = tempDir("suss-stub-project-");
  const files: Record<string, string> = {
    "template.yaml": TEMPLATE,
    "src/handlers/recordEntry.ts": HANDLER,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ES2022", strict: true },
      include: ["src/**/*.ts"],
    }),
    ...(stub === undefined
      ? {}
      : { "suss/stubs/acme-ledger-native.yaml": stub }),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

describe("a dependency stub, through extract", () => {
  it("records a send for each call of the export the guide's stub describes", async () => {
    const sends = sendsByUnit(
      await summariesOf(path.join(fixture, "tsconfig.json")),
    );

    // The second call's queue is an env var whose fallback is the same
    // queue, so both calls send there.
    expect(sends["RecordEntry.handler"]).toEqual([
      "ledger-queue via publishEntry",
    ]);
  }, 60_000);

  it("stops the run when the stub states the send in a shape the pack cannot read", async () => {
    const root = ledgerProject(`package: "@acme/ledger-native"
statements:
  - kind: performs-call
    export: publishEntry
    system: aws.sqs
    spec: { subject: 0, payload: 1 }
`);

    await expect(summariesOf(path.join(root, "tsconfig.json"))).rejects.toThrow(
      /acme-ledger-native\.yaml has a statement the aws-sqs pack cannot read:\n {2}statements\.0\.spec\.subject/,
    );
  }, 60_000);

  it("records the send once the blanks of a drafted stub are filled", async () => {
    const root = ledgerProject();
    expect(await stubDraft({ package: "@acme/ledger-native", dir: root })).toBe(
      0,
    );

    const target = path.join(root, "suss", "stubs", "acme-ledger-native.yaml");
    const filled = fs
      .readFileSync(target, "utf8")
      .replace(/system: "".*$/m, "system: aws.sqs")
      .replace(
        /spec: \{\}.*$/m,
        "spec: { subject: { at: 0 }, payload: { at: 1 } }",
      );
    fs.writeFileSync(target, filled);

    const sends = sendsByUnit(
      await summariesOf(path.join(root, "tsconfig.json")),
    );
    expect(sends["RecordEntry.handler"]).toEqual([
      "ledger-queue via publishEntry",
    ]);
  }, 60_000);
});
