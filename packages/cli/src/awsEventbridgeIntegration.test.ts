// AWS EventBridge integration test, end-to-end producer → rule pairing.
//
// Pipeline (mirrors awsSqsIntegration):
//   1. Extract code summaries from fixtures/aws-eventbridge via the
//      TypeScript adapter with @suss/framework-aws-eventbridge (producer
//      recognizer) plus a tiny lambda-handler discovery pack.
//   2. Read the SAM template via @suss/contract-cloudformation, which
//      emits EventBridge rule providers + target-Lambda consumer
//      summaries + envVarTargets on the producer's runtime-config
//      provider (the chain-collapse data the bus resolution uses).
//   3. Run checkAll over the union; assert findings.
//
// Fixture cases:
//   - OrderPlaced: producer publishes it, OrderEventsRule routes it to
//     OrderConsumer → paired, no orphan.
//   - OrderShipped: routed by the same rule but no producer publishes it
//     → messageBusConsumerOrphan.
//   - AuditConsumer: SAM EventBridgeRule with a detail-type prefix
//     filter → unresolvable → unsupportedSemantics (info).
//   - DigestFunction: SAM Type Schedule → time-triggered, no orphan.
//   - IdleRule (State: DISABLED, #460): consumer reported disabled
//     (info); the OrderCancelled send it alone routes is a producer
//     orphan; OrderArchived is not reported unused.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readMessageBusMetadata } from "@suss/behavioral-ir";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import { eventBridgeFramework } from "@suss/framework-aws-eventbridge";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/aws-eventbridge");

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

// Extraction runs ts-morph over the fixture (and resolves the AWS SDK
// type surface), so it's amortized once across the suite rather than
// re-run per assertion.
let codeSummaries: BehavioralSummary[] = [];
let stub: BehavioralSummary[] = [];
let findings: Finding[] = [];

describe("aws-eventbridge integration", () => {
  beforeAll(async () => {
    codeSummaries = await extractCode();
    stub = readStub();
    findings = checkAll([...codeSummaries, ...stub]).findings;
  }, 60000);

  it("emits a message-send interaction per publish, keyed on env-var bus + detailType", () => {
    const sends = collectSendEffects(codeSummaries);
    expect(sends.map(readChannel).sort()).toEqual([
      "ORDER_EVENT_BUS_NAME#OrderCancelled",
      "ORDER_EVENT_BUS_NAME#OrderPlaced",
    ]);
  });

  it("CFN walker emits a rule provider per routed (bus, detailType)", () => {
    const providers = stub.filter(
      (s) =>
        s.kind === "library" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus" &&
        s.identity.boundaryBinding.semantics.messageBus === "eventbridge",
    );
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "OrderEventBus#OrderArchived",
      "OrderEventBus#OrderCancelled",
      "OrderEventBus#OrderPlaced",
      "OrderEventBus#OrderShipped",
    ]);
  });

  it("CFN walker emits target-Lambda consumers, an unresolvable marker, and a schedule marker", () => {
    const consumers = stub.filter(
      (s) =>
        s.kind === "consumer" &&
        s.identity.boundaryBinding?.semantics.name === "message-bus" &&
        s.identity.boundaryBinding.semantics.messageBus === "eventbridge",
    );
    const byResolution = (status: string): string[] =>
      consumers
        .filter((c) => readMessageBusMetadata(c)?.patternResolution === status)
        .map((c) => c.identity.name)
        .sort();
    expect(byResolution("exact")).toEqual([
      "IdleConsumer#OrderArchived",
      "IdleConsumer#OrderCancelled",
      "OrderConsumer#OrderPlaced",
      "OrderConsumer#OrderShipped",
    ]);
    expect(byResolution("unresolvable")).toHaveLength(1);
    expect(byResolution("schedule")).toHaveLength(1);
  });

  it("does NOT flag the OrderPlaced producer as orphan (chain-collapse resolves the bus)", () => {
    const producerOrphans = findings.filter(
      (f) =>
        f.kind === "messageBusProducerOrphan" &&
        f.description.includes("OrderPlaced"),
    );
    expect(producerOrphans).toEqual([]);
  });

  it("orphans the OrderCancelled send, whose only subscriber deploys disabled", () => {
    const orphan = findings.find(
      (f) =>
        f.kind === "messageBusProducerOrphan" &&
        f.description.includes("OrderCancelled"),
    );
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe("warning");
    expect(orphan?.description).toContain("deployed disabled");
  });

  it("reports the disabled IdleRule consumers as disabled (info), never as consumer orphans", () => {
    const disabled = findings.filter(
      (f) => f.kind === "messageBusConsumerDisabled",
    );
    expect(disabled.map((f) => f.severity)).toEqual(["info", "info"]);
    expect(disabled.every((f) => f.description.includes("IdleRule"))).toBe(
      true,
    );
    const idleOrphans = findings.filter(
      (f) =>
        f.kind === "messageBusConsumerOrphan" &&
        f.description.includes("IdleConsumer"),
    );
    expect(idleOrphans).toEqual([]);
  });

  it("does not report OrderArchived, routed only by the disabled rule, as unused", () => {
    const unused = findings.filter(
      (f) =>
        f.kind === "messageBusUnused" &&
        f.description.includes("OrderArchived"),
    );
    expect(unused).toEqual([]);
  });

  it("flags messageBusConsumerOrphan for OrderShipped (routed but never published)", () => {
    const orphan = findings.find(
      (f) =>
        f.kind === "messageBusConsumerOrphan" &&
        f.boundary.semantics.name === "message-bus" &&
        f.boundary.semantics.channel === "OrderEventBus#OrderShipped",
    );
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe("warning");
  });

  it("does NOT flag OrderPlaced as a consumer orphan (producer publishes it)", () => {
    const orphan = findings.find(
      (f) =>
        f.kind === "messageBusConsumerOrphan" &&
        f.boundary.semantics.name === "message-bus" &&
        f.boundary.semantics.channel === "OrderEventBus#OrderPlaced",
    );
    expect(orphan).toBeUndefined();
  });

  it("surfaces the unresolvable AuditConsumer rule as unsupportedSemantics (info)", () => {
    const unresolvable = findings.find(
      (f) =>
        f.kind === "unsupportedSemantics" &&
        f.description.includes("AuditConsumer"),
    );
    expect(unresolvable).toBeDefined();
    expect(unresolvable?.severity).toBe("info");
    expect(unresolvable?.description).toContain("detail-type");
  });

  it("does NOT flag the scheduled DigestFunction as a consumer orphan", () => {
    const digestOrphan = findings.find(
      (f) =>
        f.kind === "messageBusConsumerOrphan" &&
        f.description.includes("Digest"),
    );
    expect(digestOrphan).toBeUndefined();
  });
});

async function extractCode(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack, eventBridgeFramework()],
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  for (const summary of summaries) {
    summary.location.file = path.relative(fixtureRoot, summary.location.file);
  }
  return summaries;
}

function readStub(): BehavioralSummary[] {
  return cloudFormationFileToSummaries(path.join(fixtureRoot, "template.yaml"));
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

function readChannel(effect: InteractionEffect | undefined): string | null {
  return effect?.binding.semantics.channel ?? null;
}
