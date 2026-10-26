// Deliveries a template declares, and rules matched by their pattern,
// end to end over fixtures/aws-template-wiring. The template's
// description lists the cases.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import { eventBridgeFramework } from "@suss/framework-aws-eventbridge";

import type { CheckAllResult } from "@suss/checker";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/aws-template-wiring");

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

let result: CheckAllResult;

describe("deliveries a template declares", () => {
  beforeAll(async () => {
    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
      frameworks: [lambdaHandlerPack, eventBridgeFramework()],
      cacheDir: null,
    });
    const code = await adapter.extractAll();
    for (const summary of code) {
      summary.location.file = path.relative(fixtureRoot, summary.location.file);
    }
    const template = cloudFormationFileToSummaries(
      path.join(fixtureRoot, "template.yaml"),
      { projectRoot: fixtureRoot },
    );
    result = checkAll([...code, ...template]);
  }, 60000);

  const messageBusFindings = () =>
    result.findings
      .filter((f) => f.kind.startsWith("messageBus"))
      .map((f) => {
        const semantics = f.boundary.semantics;
        const channel =
          semantics.name === "message-bus" ? semantics.channel : null;
        return `${f.kind} ${channel} @${f.provider.location.range.start}`;
      })
      .sort();

  it("reports only the source mismatch and the queue wired to nothing", () => {
    expect(messageBusFindings()).toEqual([
      "messageBusConsumerOrphan OrderEventBus#InvoicePaid @85",
      "messageBusProducerOrphan {ORDER_EVENT_BUS_NAME}#InvoicePaid @8",
      "messageBusUnused LeftoverQueue @124",
    ]);
  });

  it("pairs the dead-letter queue with the queue that redrives into it", () => {
    expect(result.pairs).toContainEqual({
      key: "bus:aws_sqs OrdersDlq",
      provider: "cloudformation:template.yaml::OrdersDlq",
      consumer: "cloudformation:template.yaml::OrdersQueue.RedrivePolicy",
    });
  });

  it("pairs the producer with the rule its source and detail-type match", () => {
    expect(
      result.pairs.filter(
        (p) =>
          p.key === "bus:eventbridge OrderPlaced" &&
          p.consumer.includes("order-producer"),
      ),
    ).not.toEqual([]);
  });
});
