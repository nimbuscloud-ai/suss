import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace, writePackConfig } from "../harness.js";

import type { CheckIntentResult } from "@suss/checker-intent";

/**
 * The brownfield journey over a boundary that is not HTTP. A queue
 * consumer that records what it read gets one intent doc, and the doc
 * says both how the outcome ends and what it resulted in.
 *
 * The point is the last step. Inferred intent describes the code it was
 * read from, so a run against that code has nothing to report, and a
 * doc the command writes that the checker then argues with is a defect
 * in the mapping.
 *
 * The store gets its own ending: a boundary intent for one is
 * authorable and reported unkeyable, because storage has no identity
 * key. What pairs is the store named as the target of a write.
 */

const DRAFT = "bus-aws-sqs-billing-invoice-paid.intent.yaml";

describe("infer intent for a queue consumer that writes a table", () => {
  const root = workspace("queue-consumer-store");
  const summaries = path.join(root, "summaries");
  const intent = path.join(root, "intent");

  /** Fill in the two blanks the draft leaves, the way a person would. */
  const curate = (file: string): void => {
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(/^purpose: "".*$/m, "purpose: Record every paid invoice once.")
        .replace(/^audience: "".*$/m, "audience: the billing team")
        .replace(/^source: inferred$/m, 'source: "inferred, curated"'),
    );
  };

  const checkIntent = (
    dir: string,
  ): { status: number | null } & {
    intent: CheckIntentResult;
  } => {
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
    // The factory that says which subject this consumer expects lives in
    // the service, so the pack is pointed at it the way a project does.
    const packConfig = writePackConfig(root, "aws-lambda", {
      subjectFactories: [{ property: "subject" }],
    });

    const code = runSuss([
      "extract",
      "--dir",
      fixture("queue-consumer-store"),
      "-f",
      `aws-lambda=${packConfig}`,
      "-f",
      "aws-dynamodb",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const drafted = runSuss([
      "infer",
      "intent",
      "--from",
      path.join(summaries, "code.json"),
      "--out",
      intent,
    ]);
    expect(drafted.status, drafted.stderr).toBe(0);
  }, 120_000);

  it("writes one doc, named after the channel the code expects", () => {
    expect(fs.readdirSync(intent)).toEqual([DRAFT]);

    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");
    expect(doc).toContain("semantics: message-bus");
    expect(doc).toContain("messageBus: aws_sqs");
    expect(doc).toContain("channel: billing.invoicePaid");
  });

  it("says the outcome results in a write to the table the code writes", () => {
    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");

    expect(doc).toContain("results:");
    expect(doc).toContain("does: writes");
    expect(doc).toContain("storageSystem: aws.dynamodb");
    expect(doc).toContain("container: Invoices");
  });

  it("says the draft is still waiting on its blanks", () => {
    const run = runSuss(["check", "--dir", summaries, "--intent", intent]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "are inferred drafts with purpose and audience still blank",
    );
    expect(run.stderr).toContain(DRAFT);
  });

  it("pairs the curated doc against the code it was drafted from", () => {
    curate(path.join(intent, DRAFT));

    const checked = checkIntent(intent);

    expect(checked.status).toBe(0);
    expect(checked.intent.findings).toEqual([]);
    expect(checked.intent.unchecked).toEqual([]);
    expect(checked.intent.checked).toEqual([
      {
        kind: "boundary",
        intent: "bus-aws-sqs-billing-invoice-paid",
        boundary: "bus:aws_sqs billing.invoicePaid",
        implementations: [
          "fixtures/queue-consumer-store/src/handlers/invoiceWorker.ts::InvoiceWorkerFunction.handler",
        ],
      },
    ]);
  });

  it("reports a declared write the consumer does not make", () => {
    const drift = path.join(root, "drift");
    fs.mkdirSync(drift, { recursive: true });
    fs.writeFileSync(
      path.join(drift, DRAFT),
      fs
        .readFileSync(path.join(intent, DRAFT), "utf8")
        .replaceAll("container: Invoices", "container: Receipts"),
    );

    const checked = checkIntent(drift);

    expect(checked.status).toBe(1);
    expect(checked.intent.findings.map((f) => f.kind)).toEqual([
      "uncoveredOutcome",
      "undeclaredOutcome",
    ]);
    expect(checked.intent.findings[0].message).toContain(
      "results in a write to aws.dynamodb:Receipts",
    );
    expect(checked.intent.findings[1].message).toContain(
      "writes aws.dynamodb:Invoices",
    );
  });

  it("takes a boundary intent for the store, and reports it unkeyable", () => {
    const store = path.join(root, "store");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(
      path.join(store, "invoices-table.intent.yaml"),
      [
        "kind: boundary",
        "name: invoices-table",
        "purpose: Keep one row per paid invoice.",
        "audience: the billing team",
        "source: author",
        "boundary:",
        "  semantics: storage",
        "  storageSystem: aws.dynamodb",
        "  container: Invoices",
        "transitions:",
        "  - id: invoice-row-written",
        "    when: an invoice has been paid",
        "    results:",
        "      - does: writes",
        "        at:",
        "          semantics: storage",
        "          storageSystem: aws.dynamodb",
        "          container: Invoices",
        "",
      ].join("\n"),
    );

    const checked = checkIntent(store);

    expect(checked.status).toBe(0);
    expect(checked.intent.findings).toHaveLength(1);
    expect(checked.intent.findings[0].kind).toBe("unkeyableBoundary");
    expect(checked.intent.findings[0].boundary).toBe("aws.dynamodb:Invoices");
    expect(checked.intent.findings[0].message).toContain(
      "a store has no key at all",
    );
    expect(checked.intent.unchecked).toEqual([
      {
        intent: "invoices-table",
        reason: "unkeyable",
        detail: "boundary can't be keyed for pairing against code",
      },
    ]);
  });
});
