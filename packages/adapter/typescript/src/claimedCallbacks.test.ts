import { describe, expect, it } from "vitest";

import {
  callbacks,
  constructedFrom,
  messageSends,
  pack,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type {
  BehavioralSummary,
  Effect,
  Interaction,
} from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { CallExpression } from "ts-morph";

// The parent's walk stops at a callback a pack claims, so whatever the
// claim's own read misses is on no summary at all.
const LATER = callbacks({ client: constructedFrom("jobs", "Jobs") })
  .methods({ later: { callback: [{ written: "callback", at: 0 }] } })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
  })
  .example("jobs.later(() => notify())");

const CLAIMS = pack("claims", [LATER], {
  languages: ["typescript"],
  recognizedAs: "@suss/claims-test",
});

const EXPORTS: PatternPack = {
  name: "exports",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["enqueue"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "functionFallthrough" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

function projectWith(source: string) {
  const project = createTestProject();
  const library = (name: string, types: string) => {
    project.createSourceFile(
      `/node_modules/${name}/package.json`,
      JSON.stringify({ name, types: "index.d.ts" }),
    );
    project.createSourceFile(`/node_modules/${name}/index.d.ts`, types);
  };
  library(
    "jobs",
    "export declare class Jobs { later(run: () => void): void; }",
  );
  library(
    "mq",
    "export declare class Queue { constructor(name: string); add(name: string, data: unknown): Promise<void>; }",
  );
  project.createSourceFile("/jobs.ts", source);
  return project;
}

function interactionsOn(
  summaries: BehavioralSummary[],
  name: string,
  kind: Interaction["class"],
): Effect[] {
  const summary = summaries.find((one) => one.identity.name === name);
  return (summary?.transitions ?? []).flatMap((transition) =>
    transition.effects.filter(
      (effect) =>
        effect.type === "interaction" && effect.interaction.class === kind,
    ),
  );
}

function calleesOf(effects: Effect[]): (string | undefined)[] {
  return effects.flatMap((effect) =>
    effect.type === "interaction" ? [effect.callee] : [],
  );
}

describe("a recognizer inside a claimed callback", () => {
  it("finds a client built at module scope, the way it does in the parent", async () => {
    const sends = messageSends({
      wire: "bullmq",
      client: constructedFrom({ from: ["mq"], named: ["Queue"] }),
      messages: { each: "theInput" },
      channel: [{ argument: { of: [{ to: "receiver" }], at: 0 } }],
      body: { whole: "message" },
      routingKey: { at: 0 },
      unsettledName: "nothing",
    })
      .methods({ add: { input: { at: 1 } } })
      .example('queue.add("welcome", { userId })');
    const project = projectWith(`
      import { Jobs } from "jobs";
      import { Queue } from "mq";

      const jobs = new Jobs();
      const queue = new Queue("mail");

      export function enqueue() {
        queue.add("now", {});
        jobs.later(() => {
          queue.add("later", {});
        });
      }
    `);
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [
        EXPORTS,
        CLAIMS,
        pack("mq", [sends], {
          languages: ["typescript"],
          recognizedAs: "@suss/mq-test",
        }),
      ],
      includeReachable: false,
    }).extractAll();

    const sent = (name: string) =>
      calleesOf(interactionsOn(summaries, name, "message-send"));
    expect(sent("enqueue")).toEqual(["queue.add"]);
    expect(sent("enqueue.jobs.later#0")).toEqual(["queue.add"]);
  });

  it("matches a call to a helper the project declares", async () => {
    const helpers: PatternPack = {
      name: "helpers",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [],
      terminals: [],
      inputMapping: { type: "positionalParams", params: [] },
      projectHelpers: {
        find: { by: "text", contains: ["Service_1."] },
        declare: () => ({
          invocationRecognizers: [
            (call) => {
              if (
                (call as CallExpression).getExpression().getText() !== "send"
              ) {
                return null;
              }
              return [
                {
                  type: "interaction",
                  binding: {
                    transport: "sqs",
                    semantics: {
                      name: "message-bus",
                      messageBus: "aws_sqs",
                      channel: "orders",
                    },
                    recognition: "helpers",
                  },
                  callee: "send",
                  interaction: { class: "message-send" },
                },
              ];
            },
          ],
        }),
      },
    };
    const project = projectWith(`
      import { Jobs } from "jobs";

      const jobs = new Jobs();

      export function send(target: string) {
        return fetch("https://example.test/", {
          headers: { "X-Wire-Target": \`Service_1.\${target}\` },
        });
      }

      export function enqueue() {
        jobs.later(() => {
          send("orders");
        });
      }
    `);
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [EXPORTS, CLAIMS, helpers],
      includeReachable: false,
    }).extractAll();

    expect(
      calleesOf(
        interactionsOn(summaries, "enqueue.jobs.later#0", "message-send"),
      ),
    ).toEqual(["send"]);
  });
});
