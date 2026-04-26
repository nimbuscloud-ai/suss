// AWS SQS integration test — end-to-end producer→consumer pairing.
//
// Pipeline:
//   1. Extract code summaries from fixtures/aws-sqs via the
//      TypeScript adapter, feeding it the @suss/framework-aws-sqs
//      pack (so producer recognizers fire) AND a tiny inline
//      lambda-handler discovery pack (so the producer / consumer
//      Lambdas are discovered as handler-kind summaries).
//   2. Read the SAM template via @suss/contract-cloudformation,
//      which emits queue providers + Lambda consumer summaries
//      AND envVarTargets metadata on the runtime-config providers
//      (the chain-collapse data the pairing uses).
//   3. Run checkAll over the union; assert findings.
//
// Three fixture cases:
//   - OrdersQueue: producer + consumer both wired up → no findings.
//   - OrphanQueue: producer in code, no consumer Lambda → orphan
//     consumer (the consumer is missing). Producer's env-var
//     ORPHAN_QUEUE_URL resolves to OrphanQueue via chain-collapse,
//     so the producer pairs against the queue provider — no
//     producer-orphan finding.
//   - NotificationsQueue: consumer Lambda + queue but no code
//     produces → orphan consumer.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import { sqsFramework } from "@suss/framework-aws-sqs";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/aws-sqs");

const lambdaHandlerPack: PatternPack = {
  name: "lambda-handler",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "event" }],
  },
};

describe("aws-sqs integration", () => {
  it("emits one message-send interaction per producer Lambda", async () => {
    const codeSummaries = await extractCode();
    const sends = collectSendEffects(codeSummaries);
    // Two producer Lambdas: OrderProducer (sends to OrdersQueue) and
    // OrphanProducer (sends to OrphanQueue).
    expect(sends).toHaveLength(2);
    const channels = sends
      .map((e) => readChannel(e))
      .filter((c): c is string => c !== null)
      .sort();
    expect(channels).toEqual(["ORDERS_QUEUE_URL", "ORPHAN_QUEUE_URL"]);
  });

  it("CFN walker emits queue providers for each AWS::SQS::Queue", () => {
    const stubSummaries = readStub();
    const queueProviders = stubSummaries.filter(
      (s) =>
        s.kind === "library" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus",
    );
    expect(queueProviders.map((p) => p.identity.name).sort()).toEqual([
      "NotificationsQueue",
      "OrdersQueue",
      "OrphanQueue",
    ]);
  });

  it("CFN walker emits consumer summaries for each Lambda Events:SQS pair", () => {
    const stubSummaries = readStub();
    const consumers = stubSummaries.filter(
      (s) =>
        s.kind === "consumer" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus",
    );
    expect(consumers.map((c) => c.identity.name).sort()).toEqual([
      "NotificationsConsumer.FromNotifications",
      "OrderConsumer.FromOrders",
    ]);
  });

  it("CFN walker captures envVarTargets on producer Lambdas (chain-collapse data)", () => {
    const stubSummaries = readStub();
    const orderProducer = stubSummaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "runtime-config" &&
        s.identity.name === "OrderProducer",
    );
    const targets = (
      orderProducer?.metadata as
        | { runtimeContract?: { envVarTargets?: Record<string, unknown> } }
        | undefined
    )?.runtimeContract?.envVarTargets;
    expect(targets).toMatchObject({
      ORDERS_QUEUE_URL: { kind: "ref", logicalId: "OrdersQueue" },
    });
  });

  it("does NOT flag OrderProducer as orphan (chain-collapse resolves the queue)", async () => {
    const findings = await runPipeline();
    const orphanProducers = findings.filter(
      (f) => f.kind === "messageBusProducerOrphan",
    );
    const orderOrphan = orphanProducers.find((f) =>
      f.description.includes("OrdersQueue"),
    );
    expect(orderOrphan).toBeUndefined();
  });

  it("flags messageBusConsumerOrphan for NotificationsQueue (consumer with no producer)", async () => {
    const findings = await runPipeline();
    const orphanConsumers = findings.filter(
      (f) => f.kind === "messageBusConsumerOrphan",
    );
    const notifs = orphanConsumers.find((f) =>
      f.description.includes("NotificationsQueue"),
    );
    expect(notifs).toBeDefined();
    expect(notifs?.severity).toBe("warning");
  });

  it("does NOT flag OrdersQueue as unused (has both producer and consumer)", async () => {
    const findings = await runPipeline();
    const unusedQueues = findings.filter((f) => f.kind === "messageBusUnused");
    const orders = unusedQueues.find((f) =>
      f.description.includes("OrdersQueue"),
    );
    expect(orders).toBeUndefined();
  });
});

async function extractCode(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack, sqsFramework()],
    cacheDir: null,
  });
  const codeSummaries = await adapter.extractAll();
  for (const summary of codeSummaries) {
    summary.location.file = path.relative(fixtureRoot, summary.location.file);
  }
  return codeSummaries;
}

function readStub(): BehavioralSummary[] {
  return cloudFormationFileToSummaries(path.join(fixtureRoot, "template.yaml"));
}

async function runPipeline(): Promise<
  Awaited<ReturnType<typeof checkAll>>["findings"]
> {
  const codeSummaries = await extractCode();
  const stubSummaries = readStub();
  const { findings } = checkAll([...codeSummaries, ...stubSummaries]);
  return findings;
}

interface InteractionEffect {
  type: "interaction";
  binding: { semantics: { name: string; channel?: string } };
  interaction: { class: string };
}

function collectSendEffects(
  summaries: BehavioralSummary[],
): InteractionEffect[] {
  const out: InteractionEffect[] = [];
  for (const summary of summaries) {
    for (const t of summary.transitions) {
      for (const e of t.effects) {
        if (
          e.type === "interaction" &&
          e.interaction.class === "message-send"
        ) {
          out.push(e as unknown as InteractionEffect);
        }
      }
    }
  }
  return out;
}

function readChannel(effect: InteractionEffect): string | null {
  return effect.binding.semantics.channel ?? null;
}
