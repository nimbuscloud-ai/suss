/**
 * AWS SNS end to end: a publisher in code paired with the Lambda a
 * subscription triggers.
 *
 * The pipeline extracts fixtures/aws-sns with the SNS pack and a tiny
 * inline lambda-handler discovery pack, reads the SAM template through
 * @suss/contract-cloudformation, and runs checkAll over the union. The
 * template declares three topics: one with both sides wired up, one
 * published to with nothing subscribed, and one subscribed to with
 * nothing publishing.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readRuntimeContractMetadata } from "@suss/behavioral-ir";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import { snsFramework } from "@suss/framework-aws-sns";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/aws-sns");

const raise = (msg: string): never => {
  throw new Error(msg);
};

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

describe("aws-sns integration", () => {
  it("emits one message-send per published message, batch entries included", async () => {
    const sends = collectSendEffects(await extractCode());
    // OrderAnnouncer publishes once and AuditAnnouncer publishes a
    // batch of two, which is two messages on the one topic.
    expect(sends).toHaveLength(3);
    expect(sends.map(readChannel).sort()).toEqual([
      "{AUDIT_EVENTS_TOPIC_ARN}",
      "{AUDIT_EVENTS_TOPIC_ARN}",
      "{ORDER_EVENTS_TOPIC_ARN}",
    ]);
  });

  it("CFN walker emits topic providers for each AWS::SNS::Topic", () => {
    const providers = readStub().filter(
      (s) =>
        s.kind === "library" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus",
    );
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "AlertEvents",
      "AuditEvents",
      "OrderEvents",
    ]);
  });

  it("CFN walker emits consumer summaries for each Lambda Events:SNS pair", () => {
    const consumers = readStub().filter(
      (s) =>
        s.kind === "consumer" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus",
    );
    expect(consumers.map((c) => c.identity.name).sort()).toEqual([
      "AlertNotifier.FromAlertEvents",
      "OrderNotifier.FromOrderEvents",
    ]);
  });

  it("CFN walker captures envVarTargets on the publisher, which is the chain-collapse data", () => {
    const announcer =
      readStub().find(
        (s) =>
          s.identity.boundaryBinding?.semantics.name === "runtime-config" &&
          s.identity.name === "OrderAnnouncer",
      ) ?? raise("no runtime");
    expect(readRuntimeContractMetadata(announcer)?.envVarTargets).toMatchObject(
      { ORDER_EVENTS_TOPIC_ARN: { kind: "ref", logicalId: "OrderEvents" } },
    );
  });

  it("pairs the publisher in code with the SNS-triggered Lambda on the topic", async () => {
    const { pairs } = await runPipeline();
    const paired = pairs.filter(
      (pair) =>
        pair.key === "bus:aws.sns OrderEvents" &&
        pair.provider.includes("OrderNotifier.FromOrderEvents") &&
        pair.consumer.includes("src/order-announcer/index.ts"),
    );
    expect(paired).toHaveLength(1);
  });

  it("does NOT flag the publisher as orphan, since chain-collapse resolves the topic", async () => {
    const { findings } = await runPipeline();
    const orphans = findings.filter(
      (f) =>
        f.kind === "messageBusProducerOrphan" &&
        f.description.includes("OrderEvents"),
    );
    expect(orphans).toEqual([]);
  });

  it("flags messageBusConsumerOrphan for AlertEvents, subscribed to with nothing publishing", async () => {
    const { findings } = await runPipeline();
    const orphan = findings.find(
      (f) =>
        f.kind === "messageBusConsumerOrphan" &&
        f.description.includes("AlertEvents"),
    );
    expect(orphan?.severity).toBe("warning");
  });

  it("does NOT flag OrderEvents as unused, since it has both a publisher and a subscriber", async () => {
    const { findings } = await runPipeline();
    const unused = findings.filter(
      (f) =>
        f.kind === "messageBusUnused" && f.description.includes("OrderEvents"),
    );
    expect(unused).toEqual([]);
  });
});

async function extractCode(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack, snsFramework()],
    cacheDir: null,
  });
  const codeSummaries = await adapter.extractAll();
  // A CodeUri is read relative to the template, so the code paths have
  // to be relative to the same place or no file lands in a code scope
  // and the topic's env var never resolves.
  for (const summary of codeSummaries) {
    summary.location.file = path.relative(fixtureRoot, summary.location.file);
  }
  return codeSummaries;
}

function readStub(): BehavioralSummary[] {
  return cloudFormationFileToSummaries(path.join(fixtureRoot, "template.yaml"));
}

async function runPipeline(): Promise<ReturnType<typeof checkAll>> {
  return checkAll([...(await extractCode()), ...readStub()]);
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
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type === "interaction" &&
          effect.interaction.class === "message-send"
        ) {
          out.push(effect as unknown as InteractionEffect);
        }
      }
    }
  }
  return out;
}

function readChannel(effect: InteractionEffect): string {
  return effect.binding.semantics.channel ?? raise("no channel");
}
