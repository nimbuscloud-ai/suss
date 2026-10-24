/**
 * Reads BullMQ. The processor a `Worker` is built with becomes a consumer
 * on the worker's queue, and each add to a `Queue` records a message
 * send on the same channel, so the two pair, and a reach question from
 * the code that adds a job goes on into the worker that runs it.
 *
 * The channel is the queue name on both sides, because a worker takes
 * every job on its queue. The job name an add passes is the send's
 * routing key and stays out of the channel. A queue name the run cannot
 * settle leaves the channel null rather than guessing one. The README
 * lists what the pack does not read.
 */

import { constructedFrom, messageSends, pack } from "@suss/recognize";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { ChannelPart, Match } from "@suss/recognize";

const BULLMQ = "bullmq";

const QUEUE = constructedFrom({ from: [BULLMQ], named: ["Queue"] });

const FLOW_PRODUCER = constructedFrom({
  from: [BULLMQ],
  named: ["FlowProducer"],
});

/** A queue takes its name when it is built, and an add never repeats it. */
const QUEUE_BUILT_WITH: readonly ChannelPart[] = [
  { argument: { of: [{ to: "receiver" }], at: 0 } },
];

/** A flow says which queue each of its jobs goes on. */
const QUEUE_NAMED_IN_THE_FLOW: readonly ChannelPart[] = [
  { property: ["queueName"] },
];

function sendDeclarations(): Match[] {
  return [
    messageSends({
      wire: "bullmq",
      client: QUEUE,
      messages: { each: "theInput" },
      channel: QUEUE_BUILT_WITH,
      body: { whole: "message" },
      routingKey: { at: 0 },
      unsettledName: "nothing",
    })
      .methods({ add: { input: { at: 1 } } })
      .example('queue.add("welcome", { userId })'),
    messageSends({
      wire: "bullmq",
      client: QUEUE,
      messages: { each: "inTheInput" },
      channel: QUEUE_BUILT_WITH,
      body: "data",
      routingKey: "name",
      unsettledName: "nothing",
    })
      .methods({ addBulk: { input: { at: 0 } } })
      .example('queue.addBulk([{ name: "welcome", data: { userId } }])'),
    // A job scheduler adds a job on every tick, from the template it is
    // given here.
    messageSends({
      wire: "bullmq",
      client: QUEUE,
      messages: { each: "theInput" },
      channel: QUEUE_BUILT_WITH,
      body: "data",
      routingKey: "name",
      unsettledName: "nothing",
    })
      .methods({ upsertJobScheduler: { input: { at: 2 } } })
      .example(
        'queue.upsertJobScheduler("nightly", { pattern: "0 0 * * *" }, { name: "digest", data: {} })',
      ),
    messageSends({
      wire: "bullmq",
      client: FLOW_PRODUCER,
      messages: { each: "theInput" },
      channel: QUEUE_NAMED_IN_THE_FLOW,
      body: "data",
      routingKey: "name",
      unsettledName: "nothing",
    })
      .methods({ add: { input: { at: 0 } } })
      .example(
        'flow.add({ name: "render", queueName: "renders", data: { id } })',
      ),
    messageSends({
      wire: "bullmq",
      client: FLOW_PRODUCER,
      messages: { each: "inTheInput" },
      channel: QUEUE_NAMED_IN_THE_FLOW,
      body: "data",
      routingKey: "name",
      unsettledName: "nothing",
    })
      .methods({ addBulk: { input: { at: 0 } } })
      .example(
        'flow.addBulk([{ name: "render", queueName: "renders", data: { id } }])',
      ),
  ];
}

export function bullmqFramework(): PatternPack {
  const sends = pack("bullmq", sendDeclarations(), {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-bullmq",
  });
  return {
    ...sends,
    discovery: [
      {
        kind: "consumer",
        match: {
          type: "callbackArgument",
          importModule: BULLMQ,
          importName: "Worker",
          callbackPosition: 1,
        },
        binding: {
          semantics: "message-bus",
          messageBus: "bullmq",
          channel: { from: "callArgument", position: 0 },
        },
        requiresImport: [BULLMQ],
      },
    ],
    terminals: [
      // A processor's return value is the job's result, which BullMQ
      // stores and nothing here pairs yet.
      {
        kind: "return",
        match: { type: "returnStatement", excludeCallReturns: false },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
      // Most processors return nothing, and a job completes when its
      // processor runs off the end.
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],
    // The job is not the message: what the add sent is `job.data`, so
    // the job keeps a role of its own rather than the one a message has.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "job" },
        { position: 1, role: "token" },
      ],
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-bullmq",
  dependencies: [{ ecosystem: "npm", name: "bullmq" }],
  reads:
    "BullMQ workers and queues: each worker's processor is a consumer on its queue, and each add to a queue is a message send on it.",
};

export default bullmqFramework;
