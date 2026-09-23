// EventBridge producers whose detail type is built from a value typed
// as a few strings, paired end to end against one rule per detail type.
// The fixture's template says which producer exercises which spelling.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import { eventBridgeFramework } from "@suss/framework-aws-eventbridge";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/aws-eventbridge-unions");

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
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "event" }],
  },
};

let codeSummaries: BehavioralSummary[] = [];
let findings: Finding[] = [];

describe("eventbridge detail types built from a few strings", () => {
  beforeAll(async () => {
    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
      frameworks: [lambdaHandlerPack, eventBridgeFramework()],
      cacheDir: null,
    });
    codeSummaries = await adapter.extractAll();
    // The template's CodeUri paths are relative to it, and a producer's
    // bus is settled through the function whose CodeUri contains it.
    for (const summary of codeSummaries) {
      summary.location.file = path.relative(fixtureRoot, summary.location.file);
    }
    const template = cloudFormationFileToSummaries(
      path.join(fixtureRoot, "template.yaml"),
    );
    findings = checkAll([...codeSummaries, ...template]).findings;
  }, 60000);

  it("sends once per string the detail type can be", () => {
    expect(sentChannels(codeSummaries)).toEqual([
      "{DOMAIN_EVENT_BUS_NAME}#account.closed",
      "{DOMAIN_EVENT_BUS_NAME}#account.opened",
      "{DOMAIN_EVENT_BUS_NAME}#metric.{name}",
      "{DOMAIN_EVENT_BUS_NAME}#record.delete",
      "{DOMAIN_EVENT_BUS_NAME}#record.insert",
      "{DOMAIN_EVENT_BUS_NAME}#record.update",
      "{DOMAIN_EVENT_BUS_NAME}#report.daily",
      "{DOMAIN_EVENT_BUS_NAME}#report.weekly",
    ]);
  });

  it("answers every rule the union, the enum and the alias route", () => {
    expect(orphanedRuleChannels(findings)).toEqual([
      "DomainEventBus#metric.m01",
    ]);
  });

  it("leaves no enumerated send without a rule", () => {
    const orphanedSends = findings
      .filter((finding) => finding.kind === "messageBusProducerOrphan")
      .map((finding) => finding.description);
    expect(orphanedSends).toHaveLength(1);
    expect(orphanedSends[0]).toContain("metric.{name}");
  });
});

function sentChannels(summaries: BehavioralSummary[]): string[] {
  const channels: string[] = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type === "interaction" &&
          effect.interaction.class === "message-send" &&
          effect.binding.semantics.name === "message-bus" &&
          effect.binding.semantics.channel !== null
        ) {
          channels.push(effect.binding.semantics.channel);
        }
      }
    }
  }
  return [...new Set(channels)].sort();
}

function orphanedRuleChannels(all: Finding[]): string[] {
  return all
    .filter(
      (finding) =>
        finding.kind === "messageBusConsumerOrphan" &&
        finding.boundary.semantics.name === "message-bus",
    )
    .map((finding) =>
      finding.boundary.semantics.name === "message-bus"
        ? (finding.boundary.semantics.channel ?? "")
        : "",
    )
    .sort();
}
