import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

import type { CheckIntentResult } from "@suss/checker-intent";

/**
 * The brownfield journey over a service built out of Lambdas. Nothing
 * here serves HTTP: every function is reached by being invoked by name,
 * which is what a document has to be able to say before a service in
 * this style gets any intent at all.
 *
 * The last steps are the point. Inferred intent describes the code it
 * was read from, so a run against that code has nothing to report, and
 * a doc the command writes that the checker then argues with is a
 * defect in the mapping.
 */

const ORDER_API = "unit-lambda-order-api.intent.yaml";
const REPORT_BUILDER = "unit-lambda-report-builder.intent.yaml";
const ARCHIVE_WORKER = "unit-lambda-archive-worker.intent.yaml";

describe("infer intent for Lambdas that invoke each other", () => {
  const root = workspace("lambda-invoke-intent");
  const summaries = path.join(root, "summaries");
  const intent = path.join(root, "intent");

  /** Fill in the two blanks the draft leaves, the way a person would. */
  const curate = (file: string): void => {
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(/^purpose: "".*$/m, "purpose: Build the report for an order.")
        .replace(/^audience: "".*$/m, "audience: the orders team")
        .replace(/^source: inferred$/m, 'source: "inferred, curated"'),
    );
  };

  /** One curated doc with one thing changed, in a folder of its own. */
  const driftedInto = (
    label: string,
    file: string,
    change: (doc: string) => string,
  ): string => {
    const dir = path.join(root, label);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, file),
      change(fs.readFileSync(path.join(intent, file), "utf8")),
    );
    return dir;
  };

  const checkIntent = (
    dir: string,
  ): { status: number | null; intent: CheckIntentResult } => {
    const run = runSuss([
      "check",
      "--dir",
      summaries,
      "--intent",
      dir,
      "--json",
    ]);
    return {
      status: run.status,
      intent: (JSON.parse(run.stdout) as { intent: CheckIntentResult }).intent,
    };
  };

  beforeAll(() => {
    fs.mkdirSync(summaries, { recursive: true });

    const code = runSuss([
      "extract",
      "--dir",
      fixture("lambda-invoke"),
      "-f",
      "aws-lambda",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    // Which function each handler is deployed as is the template's to
    // say, so the run that reads it has to be in the same folder.
    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("lambda-invoke"), "template.yaml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);

    const drafted = runSuss([
      "infer",
      "intent",
      "--from",
      summaries,
      "--out",
      intent,
    ]);
    expect(drafted.status, drafted.stderr).toBe(0);
  }, 120_000);

  it("writes a doc per deployed function, on the name the platform knows", () => {
    expect(fs.readdirSync(intent).sort()).toEqual([
      ARCHIVE_WORKER,
      ORDER_API,
      REPORT_BUILDER,
    ]);

    const doc = fs.readFileSync(path.join(intent, REPORT_BUILDER), "utf8");
    expect(doc).toContain(
      [
        "boundary:",
        "  semantics: unit-invocation",
        "  deploymentTarget: lambda",
        "  instanceName: ReportBuilder",
      ].join("\n"),
    );
  });

  it("says what the function gives back, and which unit it invokes", () => {
    const doc = fs.readFileSync(path.join(intent, REPORT_BUILDER), "utf8");

    expect(doc).toContain(
      [
        "  - id: returns",
        "    when: every call reaches this outcome",
        "    returns:",
        "      body:",
        "        type: object",
        "        properties:",
        "          reportId:",
        "            type: string",
        "    results:",
        "      - invokes: unit:lambda {ARCHIVE_WORKER_FUNCTION}",
      ].join("\n"),
    );
  });

  it("writes the invoke in the same words suss ask asks with", () => {
    const run = runSuss([
      "ask",
      "--dir",
      summaries,
      "what invokes unit:lambda {ARCHIVE_WORKER_FUNCTION}",
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "1 unit invokes unit:lambda {ARCHIVE_WORKER_FUNCTION}",
    );
    expect(run.stdout).toContain("ReportBuilder.handler");
  });

  it("names the function this stack does not deploy as the code names it", () => {
    const doc = fs.readFileSync(path.join(intent, ORDER_API), "utf8");

    expect(doc).toContain("      - invokes: unit:lambda legacy-pricing");
  });

  it("pairs every curated doc against the code it was drafted from", () => {
    curate(path.join(intent, ORDER_API));
    curate(path.join(intent, REPORT_BUILDER));
    curate(path.join(intent, ARCHIVE_WORKER));

    const checked = checkIntent(intent);

    expect(checked.status).toBe(0);
    expect(checked.intent.findings).toEqual([]);
    expect(checked.intent.unchecked).toEqual([]);
    expect(
      checked.intent.checked.map((one) =>
        one.kind === "boundary" ? one.boundary : one.intent,
      ),
    ).toEqual([
      "unit:lambda ArchiveWorker",
      "unit:lambda OrderApi",
      "unit:lambda ReportBuilder",
    ]);
  });

  it("reports an invoke of a unit the function never invokes", () => {
    const drift = driftedInto("callee", REPORT_BUILDER, (doc) =>
      doc.replace("{ARCHIVE_WORKER_FUNCTION}", "OrderApi"),
    );

    const checked = checkIntent(drift);

    expect(checked.intent.findings.map((f) => f.kind)).toEqual([
      "uncoveredOutcome",
      "undeclaredOutcome",
    ]);
    expect(checked.intent.findings[0].message).toContain(
      "results in an invoke of unit:lambda OrderApi",
    );
    expect(checked.intent.findings[1].message).toContain(
      "invokes unit:lambda {ARCHIVE_WORKER_FUNCTION}",
    );
  });

  it("reports a return shape the function does not produce", () => {
    const drift = driftedInto("body", REPORT_BUILDER, (doc) =>
      doc.replace(
        "          reportId:\n            type: string",
        "          archived:\n            type: boolean",
      ),
    );

    const checked = checkIntent(drift);

    const reported = checked.intent.findings.filter(
      (f) => f.kind === "outcomeShapeMismatch",
    );
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain(
      "Body shape for a return value at unit:lambda ReportBuilder",
    );
  });

  it("takes a doc for a unit named at run time, and reports it unkeyable", () => {
    const dir = path.join(root, "unnamed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "some-lambda.intent.yaml"),
      [
        "kind: boundary",
        "name: some-lambda",
        "purpose: Build a report for whoever asks.",
        "audience: the orders team",
        "source: author",
        "boundary:",
        "  semantics: unit-invocation",
        "  deploymentTarget: lambda",
        "transitions:",
        "  - id: returns",
        "    when: a report was asked for",
        "    returns:",
        "      body:",
        "        properties:",
        "          reportId: { type: string }",
        "",
      ].join("\n"),
    );

    const checked = checkIntent(dir);

    expect(checked.status).toBe(0);
    expect(checked.intent.findings).toHaveLength(1);
    expect(checked.intent.findings[0].kind).toBe("unkeyableBoundary");
    expect(checked.intent.findings[0].message).toContain(
      "an invoked unit needs a deployment target and the name the platform knows it by",
    );
    expect(checked.intent.unchecked).toEqual([
      {
        intent: "some-lambda",
        reason: "unkeyable",
        detail: "boundary can't be keyed for pairing against code",
      },
    ]);
  });
});
