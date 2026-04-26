// runtime-config integration test — end-to-end env-var pairing.
//
// Pipeline: extract Lambda handler summaries (via a tiny inline pack
// that discovers `export async function handler`), generate
// runtime-config provider summaries from the SAM template, run
// checkAll, assert the three drift findings:
//
//   1. envVarUnprovided — Checkout reads STRIPE_API_KEY,
//      template misnames it STRIPE_KEY (typo)
//   2. envVarUnprovided — WebhookHandler reads KAFKA_BROKER,
//      template doesn't declare it (omission)
//   3. envVarUnused     — BatchReconcile declares
//      LEGACY_FEATURE_FLAG, no code reads it (dead config)

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { cloudFormationFileToSummaries } from "@suss/stub-cloudformation";

import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/runtimeConfig");

/**
 * Tiny pack that discovers `export async function handler` (and
 * `export const handler = ...`) in any source file. Lambdas don't
 * fit a framework pack — they're plain function exports — so a
 * synthetic namedExport pack is the most direct fit here.
 */
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

describe("runtime-config integration", () => {
  it("flags STRIPE_API_KEY (typo'd as STRIPE_KEY in template) as unprovided", async () => {
    const findings = await runPipeline();
    const unprovided = findings.filter((f) => f.kind === "envVarUnprovided");
    const stripe = unprovided.find((f) =>
      f.description.includes("STRIPE_API_KEY"),
    );
    expect(stripe).toBeDefined();
    expect(stripe?.severity).toBe("error");
    expect(stripe?.description).toContain("Checkout");
  });

  it("flags KAFKA_BROKER (omitted from template) as unprovided", async () => {
    const findings = await runPipeline();
    const unprovided = findings.filter((f) => f.kind === "envVarUnprovided");
    const kafka = unprovided.find((f) =>
      f.description.includes("KAFKA_BROKER"),
    );
    expect(kafka).toBeDefined();
    expect(kafka?.severity).toBe("error");
    expect(kafka?.description).toContain("WebhookHandler");
  });

  it("flags LEGACY_FEATURE_FLAG (declared but never read) as unused", async () => {
    const findings = await runPipeline();
    const unused = findings.filter((f) => f.kind === "envVarUnused");
    const legacy = unused.find((f) =>
      f.description.includes("LEGACY_FEATURE_FLAG"),
    );
    expect(legacy).toBeDefined();
    expect(legacy?.severity).toBe("warning");
    expect(legacy?.description).toContain("BatchReconcile");
  });

  it("does not flag platform-injected vars as unused", async () => {
    const findings = await runPipeline();
    const unused = findings.filter((f) => f.kind === "envVarUnused");
    // AWS_REGION etc. are platform-injected — no code in the fixture
    // reads them, but they should NOT surface as envVarUnused
    // because the stub marks them as source=platform.
    const platformLeak = unused.find((f) =>
      f.description.includes("AWS_REGION"),
    );
    expect(platformLeak).toBeUndefined();
  });

  it("does not flag declared-and-read vars (DATABASE_URL, STRIPE_WEBHOOK_SECRET)", async () => {
    const findings = await runPipeline();
    const everything = [
      ...findings.filter((f) => f.kind === "envVarUnprovided"),
      ...findings.filter((f) => f.kind === "envVarUnused"),
    ];
    expect(
      everything.find((f) => f.description.includes("DATABASE_URL")),
    ).toBeUndefined();
    expect(
      everything.find((f) => f.description.includes("STRIPE_WEBHOOK_SECRET")),
    ).toBeUndefined();
  });

  it("emits no runtimeScopeUnknown — every Lambda has CodeUri", async () => {
    const findings = await runPipeline();
    expect(
      findings.filter((f) => f.kind === "runtimeScopeUnknown"),
    ).toHaveLength(0);
  });
});

async function runPipeline(): Promise<
  Awaited<ReturnType<typeof checkAll>>["findings"]
> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack],
    cacheDir: null,
  });
  const codeSummaries = await adapter.extractAll();
  // Rewrite location.file to project-relative so prefix-matching
  // against the SAM CodeUri ("src/checkout/" etc.) works. The
  // adapter records absolute paths during extraction; the CLI does
  // this rewrite normally before publishing.
  for (const summary of codeSummaries) {
    summary.location.file = path.relative(fixtureRoot, summary.location.file);
  }

  const stubSummaries = cloudFormationFileToSummaries(
    path.join(fixtureRoot, "template.yaml"),
  );

  const { findings } = checkAll([...codeSummaries, ...stubSummaries]);
  return findings;
}
