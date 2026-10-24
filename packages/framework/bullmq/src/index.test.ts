import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { interactionsOf, packUnderTest } from "@suss/pack-harness";
import { createTestProject } from "@suss/test-project";

import { bullmqFramework, declares } from "./index.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

// Every module a fixture imports has to be on disk, since an origin
// check follows the import back to the module that declared it.
const BULLMQ_TYPES = `
export declare class Job<D = any> {
  name: string;
  data: D;
  id?: string;
}
export declare class Queue<D = any> {
  constructor(name: string, opts?: unknown);
  add(name: string, data: D, opts?: unknown): Promise<Job<D>>;
  addBulk(jobs: Array<{ name: string; data: D; opts?: unknown }>): Promise<Job<D>[]>;
  upsertJobScheduler(
    id: string,
    repeat: unknown,
    template?: { name?: string; data?: D; opts?: unknown },
  ): Promise<Job<D>>;
}
export declare class FlowProducer {
  constructor(opts?: unknown);
  add(flow: { name: string; queueName: string; data?: unknown }): Promise<unknown>;
  addBulk(flows: Array<{ name: string; queueName: string; data?: unknown }>): Promise<unknown>;
}
export declare class Worker<D = any> {
  constructor(
    name: string,
    processor?: string | ((job: Job<D>, token?: string) => Promise<unknown>),
    opts?: unknown,
  );
}
`;

const LIBRARY = { bullmq: BULLMQ_TYPES };

const harness = () => packUnderTest(bullmqFramework(), { library: LIBRARY });

const sendsIn = (source: string) =>
  interactionsOf(harness().effectsIn(source), "message-send");

const sendsAcross = (files: Record<string, string>, entry: string) =>
  interactionsOf(harness().effectsAcross(files, entry), "message-send");

function channelOf(effect: Effect | undefined): string | null | undefined {
  const semantics =
    effect?.type === "interaction" ? effect.binding?.semantics : undefined;
  return semantics?.name === "message-bus" ? semantics.channel : undefined;
}

const channelsOf = (effects: Effect[]) => effects.map(channelOf);

function sentOf(effect: Effect | undefined) {
  return effect?.type === "interaction" &&
    effect.interaction.class === "message-send"
    ? effect.interaction
    : null;
}

describe("an add to a queue", () => {
  it("goes on the queue the queue was built with, keyed by the job name", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      const emails = new Queue("emails");
      export async function signUp(userId: string) {
        await emails.add("welcome", { userId });
      }
    `);
    expect(channelsOf(sends)).toEqual(["emails"]);
    expect(sends[0]?.type === "interaction" ? sends[0].callee : null).toBe(
      "emails.add",
    );
    const sent = sentOf(sends[0]);
    expect(sent?.routingKey).toBe("welcome");
    expect(sent?.body).toMatchObject({
      kind: "object",
      fields: { userId: { kind: "identifier" } },
    });
  });

  it("settles a queue name kept in a constant another module exports", () => {
    const sends = sendsAcross(
      {
        "/names.ts": `export const EMAILS = "emails";`,
        "/send.ts": `
          import { Queue } from "bullmq";
          import { EMAILS } from "./names";
          const queue = new Queue(EMAILS);
          export const send = () => queue.add("welcome", {});
        `,
      },
      "/send.ts",
    );
    expect(channelsOf(sends)).toEqual(["emails"]);
  });

  it("follows a queue built in another module", () => {
    const sends = sendsAcross(
      {
        "/queues.ts": `
          import { Queue } from "bullmq";
          export const emailQueue = new Queue("emails");
        `,
        "/send.ts": `
          import { emailQueue } from "./queues";
          export const send = () => emailQueue.add("welcome", {});
        `,
      },
      "/send.ts",
    );
    expect(channelsOf(sends)).toEqual(["emails"]);
  });

  it("follows a queue a class keeps on a field", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      export class Jobs {
        private queue: Queue;
        constructor() {
          this.queue = new Queue("jobs");
        }
        trigger(name: string, payload: unknown) {
          return this.queue.add(name, { payload });
        }
      }
    `);
    expect(channelsOf(sends)).toEqual(["jobs"]);
    // A job name the run cannot settle is left off rather than guessed.
    expect(sentOf(sends[0])?.routingKey).toBeUndefined();
  });

  it("follows a queue a project function builds and caches", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      let cached: Queue | undefined;
      const createQueue = () => new Queue("jobs");
      const getQueue = async () => {
        if (cached) {
          return { queue: cached };
        }
        const queue = createQueue();
        cached = queue;
        return { queue };
      };
      export async function send(data: unknown) {
        const { queue } = await getQueue();
        return await queue.add("report", data);
      }
    `);
    expect(channelsOf(sends)).toEqual(["jobs"]);
  });

  it("records nothing for a queue handed in as a parameter", () => {
    // Only a type says the parameter is a queue, and the origin check
    // reads where a value was built, so this add is missed.
    const sends = sendsIn(`
      import type { Queue } from "bullmq";
      export const send = (queue: Queue) => queue.add("welcome", {});
    `);
    expect(sends).toEqual([]);
  });

  it("records the add with no channel when the queue name does not settle", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      const queue = new Queue(process.env.QUEUE_NAME as string);
      export const send = () => queue.add("welcome", {});
    `);
    expect(channelsOf(sends)).toEqual([null]);
  });

  it("leaves alone an add on a queue that is not BullMQ's", () => {
    const sends = sendsIn(`
      class Queue {
        constructor(readonly name: string) {}
        add(name: string, data: unknown) {}
      }
      const queue = new Queue("emails");
      export const send = () => queue.add("welcome", {});
    `);
    expect(sends).toEqual([]);
  });

  it("records one send per job a bulk add lists", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      const queue = new Queue("emails");
      export const send = () =>
        queue.addBulk([
          { name: "welcome", data: { userId: "1" } },
          { name: "digest", data: { userId: "2" } },
        ]);
    `);
    expect(channelsOf(sends)).toEqual(["emails", "emails"]);
    expect(sends.map((one) => sentOf(one)?.routingKey)).toEqual([
      "welcome",
      "digest",
    ]);
  });

  it("reads a job scheduler as a send of the job its template describes", () => {
    const sends = sendsIn(`
      import { Queue } from "bullmq";
      const queue = new Queue("reports");
      export const schedule = () =>
        queue.upsertJobScheduler(
          "nightly",
          { pattern: "0 0 * * *" },
          { name: "digest", data: { day: "today" } },
        );
    `);
    expect(channelsOf(sends)).toEqual(["reports"]);
    expect(sentOf(sends[0])?.routingKey).toBe("digest");
  });
});

describe("a flow", () => {
  it("goes on the queue each of its jobs says", () => {
    const sends = sendsIn(`
      import { FlowProducer } from "bullmq";
      const flow = new FlowProducer();
      export const render = (id: string) =>
        flow.add({ name: "render", queueName: "renders", data: { id } });
    `);
    expect(channelsOf(sends)).toEqual(["renders"]);
    expect(sentOf(sends[0])?.routingKey).toBe("render");
  });

  it("records one send per flow a bulk add lists", () => {
    const sends = sendsIn(`
      import { FlowProducer } from "bullmq";
      const flow = new FlowProducer();
      export const render = () =>
        flow.addBulk([
          { name: "render", queueName: "renders", data: {} },
          { name: "upload", queueName: "uploads", data: {} },
        ]);
    `);
    expect(channelsOf(sends)).toEqual(["renders", "uploads"]);
  });
});

async function extract(
  files: Record<string, string>,
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/bullmq/package.json",
    JSON.stringify({ name: "bullmq", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/bullmq/index.d.ts", BULLMQ_TYPES);
  for (const [file, text] of Object.entries(files)) {
    project.createSourceFile(file, text);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [bullmqFramework()],
  });
  return await adapter.extractAll();
}

const consumersOf = (summaries: BehavioralSummary[]) =>
  summaries.filter((one) => one.kind === "consumer");

function busOf(summary: BehavioralSummary | undefined) {
  const semantics = summary?.identity.boundaryBinding?.semantics;
  return semantics?.name === "message-bus" ? semantics : null;
}

describe("a worker", () => {
  it("makes its processor a consumer on the worker's queue", async () => {
    const summaries = await extract({
      "/worker.ts": `
        import { Worker } from "bullmq";
        export const worker = new Worker("emails", async (job) => {
          if (!job.data.userId) {
            throw new Error("no user");
          }
          return job.data.userId;
        });
      `,
    });
    const [consumer] = consumersOf(summaries);
    expect(busOf(consumer)).toMatchObject({
      messageBus: "bullmq",
      channel: "emails",
    });
    expect(consumer?.identity.name).toBe("Worker emails");
    expect(consumer?.inputs).toMatchObject([
      { type: "parameter", name: "job", role: "job" },
    ]);
    expect(consumer?.transitions.length).toBeGreaterThanOrEqual(2);
  });

  it("follows a processor written in another module and passed by name", async () => {
    const summaries = await extract({
      "/names.ts": `export const EMAILS = "emails";`,
      "/processor.ts": `
        export async function sendEmail(job: { data: { to: string } }) {
          return job.data.to;
        }
      `,
      "/worker.ts": `
        import { Worker } from "bullmq";
        import { EMAILS } from "./names";
        import { sendEmail } from "./processor";
        export const worker = new Worker(EMAILS, sendEmail);
      `,
    });
    const [consumer] = consumersOf(summaries);
    expect(busOf(consumer)?.channel).toBe("emails");
    expect(consumer?.location.file).toContain("processor.ts");
  });

  it("names no channel when the queue name does not settle", async () => {
    const summaries = await extract({
      "/worker.ts": `
        import { Worker } from "bullmq";
        export const worker = new Worker(process.env.QUEUE as string, async () => {});
      `,
    });
    const [consumer] = consumersOf(summaries);
    expect(busOf(consumer)).toMatchObject({
      messageBus: "bullmq",
      channel: null,
    });
  });

  it("gives no unit for a processor the library loads from a file", async () => {
    const summaries = await extract({
      "/worker.ts": `
        import { Worker } from "bullmq";
        export const worker = new Worker("emails", "./processor.js");
      `,
    });
    expect(consumersOf(summaries)).toEqual([]);
  });

  it("leaves alone a Worker that is not BullMQ's", async () => {
    const summaries = await extract({
      "/worker.ts": `
        class Worker {
          constructor(name: string, run: () => void) {}
        }
        export const worker = new Worker("emails", () => {});
      `,
    });
    expect(consumersOf(summaries)).toEqual([]);
  });
});

describe("the pack's declaration", () => {
  it("is found by a project that depends on bullmq", () => {
    expect(declares.dependencies).toEqual([
      { ecosystem: "npm", name: "bullmq" },
    ]);
  });
});
