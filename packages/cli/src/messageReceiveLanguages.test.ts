/**
 * The message-receive ending on the same Lambda handler in TypeScript,
 * Python and Ruby: one declaration, read over each adapter's facts. The
 * handler parses each record's body in a loop and keeps it in a name, and
 * parses another in a callback and reads one field straight off the
 * parse. A helper typed as the Lambda record is a receive where the
 * language writes types down, and Ruby, which writes none, pins that it
 * finds nothing there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import {
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { compile, messageReceives, typed } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const RECOGNITION = "@suss/message-receive-test";

const RECEIVES = messageReceives({
  wire: "aws_sqs",
  codec: "json",
  envelope: [
    { path: [{ read: "Records" }, { each: true }, { read: "body" }] },
    {
      from: typed({
        from: ["aws-lambda", "aws_lambda_typing.events"],
        named: ["SQSRecord"],
      }),
      path: [{ read: "body" }],
    },
  ],
});

/** A pack of the one declaration, the way every adapter loads one. */
const PACK = {
  name: "receives",
  protocol: "sqs",
  languages: ["typescript", "python", "ruby"],
  discovery: [],
  terminals: [],
  inputMapping: { type: "positionalParams" as const, params: [] },
  invocationRecognizers: [compile(RECEIVES.declared, RECOGNITION)],
  accessRecognizers: [],
};

// Python keys a comprehension's variable by the function around it, so
// the callback's variable has a name of its own in every language.
const TYPESCRIPT = `
import type { SQSRecord } from "aws-lambda";
declare function post(id: unknown): void;
declare function charge(account: unknown): void;

export async function handler(event: any) {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    order.seen = true;
    post(order.id); charge(order.account);
  }
  event.Records.map((message: any) => JSON.parse(message.body).kind);
  JSON.parse(event.settings);
}

export function readOne(record: SQSRecord) {
  return JSON.parse(record.body).id;
}
`;

const PYTHON = `import json

from aws_lambda_typing.events import SQSRecord


def handler(event, context):
    for record in event["Records"]:
        order = json.loads(record["body"])
        order["seen"] = True
        post(order["id"]); charge(order["account"])
    [json.loads(message["body"])["kind"] for message in event["Records"]]
    json.loads(event["settings"])


def read_one(record: SQSRecord):
    return json.loads(record["body"])["id"]
`;

const RUBY = `require "json"

module Orders
  def self.handler(event:, context:)
    event["Records"].each do |record|
      order = JSON.parse(record["body"])
      order["seen"] = true
      post(order["id"]); charge(order["account"])
    end
    event["Records"].map { |message| JSON.parse(message["body"])["kind"] }
    JSON.parse(event["settings"])
  end

  def self.read_one(record)
    JSON.parse(record["body"])["id"]
  end
end
`;

type Receive = Extract<Effect, { type: "interaction" }> & {
  interaction: { class: "message-receive" };
};

/** The wire and the fields of each receive the declaration recorded. */
function receivesIn(effects: readonly Effect[]) {
  return effects
    .filter(
      (effect): effect is Receive =>
        effect.type === "interaction" &&
        effect.interaction.class === "message-receive" &&
        effect.binding.recognition === RECOGNITION,
    )
    .map((effect) => ({
      wire:
        effect.binding.semantics.name === "message-bus"
          ? effect.binding.semantics.messageBus
          : "not a message bus",
      fields: Object.keys(
        (effect.interaction.body as { fields?: object } | undefined)?.fields ??
          {},
      ),
    }));
}

function effectsIn(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) => transition.effects),
  );
}

/** The receives in one function's summary, by the name it is summarized under. */
function receivesOf(summaries: readonly BehavioralSummary[], name: string) {
  return receivesIn(
    effectsIn(summaries.filter((summary) => summary.identity.name === name)),
  );
}

function typescriptEffects(): Effect[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/@types/aws-lambda/package.json",
    JSON.stringify({ name: "@types/aws-lambda", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/@types/aws-lambda/index.d.ts",
    "export interface SQSRecord { body: string }\n",
  );
  const file = project.createSourceFile("/handler.ts", TYPESCRIPT);
  const store = ResolutionStore.forPacks([PACK]);
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const context = invocationContextFor(node, store);
    for (const hook of PACK.invocationRecognizers) {
      effects.push(...(hook(node, context) ?? []));
    }
  });
  return effects;
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-message-receives-")),
  );
  fs.mkdirSync(path.join(root, "orders"));
  fs.writeFileSync(path.join(root, "orders/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/orders"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/orders.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "orders/__init__.py")],
    roots: [root],
    packs: [PACK],
    modules: [{ name: "orders", root: path.join(root, "orders") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/orders.rb")],
    packs: [PACK],
    modules: [{ name: "orders", root: path.join(root, "lib/orders") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

const IN_THE_LOOP = { wire: "aws_sqs", fields: ["id", "account"] };
const IN_THE_CALLBACK = { wire: "aws_sqs", fields: ["kind"] };
const IN_THE_HELPER = { wire: "aws_sqs", fields: ["id"] };

describe("the message-receive ending, in every language", () => {
  it("reads the loop, the callback and the typed helper in TypeScript", () => {
    expect(receivesIn(typescriptEffects())).toEqual([
      IN_THE_LOOP,
      IN_THE_CALLBACK,
      IN_THE_HELPER,
    ]);
  });

  it("reads the same three in Python", async () => {
    const summaries = await pythonSummaries();
    expect(receivesOf(summaries, "handler")).toEqual([
      IN_THE_LOOP,
      IN_THE_CALLBACK,
    ]);
    expect(receivesOf(summaries, "read_one")).toEqual([IN_THE_HELPER]);
  });

  it("reads the loop and the callback in Ruby, and nothing in the helper, since Ruby writes no type for the record", async () => {
    const summaries = await rubySummaries();
    expect(receivesOf(summaries, "Orders.handler")).toEqual([
      IN_THE_LOOP,
      IN_THE_CALLBACK,
    ]);
    expect(receivesOf(summaries, "Orders.read_one")).toEqual([]);
  });
});
