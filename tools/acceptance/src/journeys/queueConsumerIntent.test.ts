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
const ROUTE = "get-invoices-invoice-id.intent.yaml";
const ROUTE_PRD = "get-invoices-invoice-id.prd.yaml";

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

  it("writes a doc per boundary, the queue one on its channel", () => {
    expect(fs.readdirSync(intent).sort()).toEqual([DRAFT, ROUTE]);

    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");
    expect(doc).toContain("semantics: message-bus");
    expect(doc).toContain("messageBus: aws_sqs");
    expect(doc).toContain("channel: billing.invoicePaid");
  });

  it("says which store a branch read, and what it came back with", () => {
    const doc = fs.readFileSync(path.join(intent, ROUTE), "utf8");

    expect(doc).toContain(
      [
        "  - id: 404-not-found",
        "    when:",
        "      - reads: aws.dynamodb:Invoices",
        "        finds: nothing",
      ].join("\n"),
    );
    expect(doc).toContain(
      [
        "  - id: 409-conflict",
        "    when:",
        "      - reads: aws.dynamodb:Invoices",
        "        finds: something",
        "        where: settledAt is set",
      ].join("\n"),
    );
    // The name of the call, which a rename would break, stays out of it.
    expect(doc).not.toContain("dynamo.send");
  });

  it("gives the fall-through branch its own condition, not its position", () => {
    const doc = fs.readFileSync(path.join(intent, ROUTE), "utf8");

    expect(doc).toContain(
      [
        "  - id: 200-ok",
        "    when:",
        "      - reads: aws.dynamodb:Invoices",
        "        finds: something",
        "        where: settledAt is missing",
      ].join("\n"),
    );
    expect(doc).not.toContain("otherwise");
  });

  it("says the outcome results in a write, in the words ask asks with", () => {
    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");

    expect(doc).toContain(
      "    results:\n      - writes: aws.dynamodb:Invoices",
    );
  });

  it("keeps a sentence for a guard no boundary explains, and states both arms", () => {
    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");

    expect(doc).toContain("when: invoiceId is not a string");
    expect(doc).toContain("when: invoiceId is a string");
    expect(doc).not.toContain("!(");
  });

  it("says which store the route reads and what it keys on", () => {
    const doc = fs.readFileSync(path.join(intent, ROUTE), "utf8");

    expect(doc).toContain(
      [
        "    results:",
        "      - reads: aws.dynamodb:Invoices",
        "        by:",
        "          - invoiceId",
      ].join("\n"),
    );
  });

  it("opens by saying what it is, and reads in parts", () => {
    const doc = fs.readFileSync(path.join(intent, DRAFT), "utf8");

    expect(doc).toContain(
      "# bus:aws_sqs billing.invoicePaid, as the code has it today.",
    );
    expect(doc).toContain("src/handlers/invoiceWorker.ts");
    expect(doc).toContain("kind: boundary\n\nname: ");
    expect(doc).toContain("source: inferred\n\nboundary:");
  });

  it("says the draft is still waiting on its blanks", () => {
    const run = runSuss(["check", "--dir", summaries, "--intent", intent]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "are inferred drafts with blanks still in them",
    );
    expect(run.stderr).toContain(DRAFT);
  });

  it("refuses to draft a PRD against outcome ids nobody has renamed yet", () => {
    const run = runSuss(["infer", "prd", "--from", intent]);

    expect(run.status).toBe(1);
    expect(run.output).toContain("blanks still in them");
    expect(run.output).toContain("has to load before this can write one");
  });

  it("pairs both curated docs against the code they were drafted from", () => {
    curate(path.join(intent, DRAFT));
    curate(path.join(intent, ROUTE));

    const checked = checkIntent(intent);

    expect(checked.status).toBe(0);
    expect(checked.intent.findings).toEqual([]);
    expect(checked.intent.unchecked).toEqual([]);
    expect(
      checked.intent.checked.map((c) =>
        c.kind === "boundary" ? c.boundary : c.intent,
      ),
    ).toEqual(["bus:aws_sqs billing.invoicePaid", "GET /invoices/{invoiceId}"]);
  });

  it("drafts a PRD per boundary once the outcome ids are settled", () => {
    // Curating renamed one outcome, which is what a PRD drafted with the
    // boundary document would already be pointing past.
    const renamed = fs
      .readFileSync(path.join(intent, ROUTE), "utf8")
      .replace("id: 404-not-found", "id: no-such-invoice");
    fs.writeFileSync(path.join(intent, ROUTE), renamed);

    const run = runSuss(["infer", "prd", "--from", intent]);
    expect(run.status, run.stderr).toBe(0);

    const doc = fs.readFileSync(path.join(intent, ROUTE_PRD), "utf8");
    expect(doc).toContain("kind: prd");
    expect(doc).toContain('title: "" # what this document covers');
    expect(doc).toContain('- when: "" # the situation, in your words');
    expect(doc).toContain("link: get-invoices-invoice-id.no-such-invoice");
  });

  it("says which outcome nobody has written a scenario for", () => {
    const short = driftedInto("undescribed", ROUTE_PRD, (doc) =>
      doc
        .replace(/^title: "".*$/m, "title: Invoice lookup")
        .replace(/^purpose: "".*$/m, "purpose: Callers see one invoice.")
        .replace(/^audience: "".*$/m, "audience: the billing team")
        .replaceAll(/^(\s*)- when: "".*$/gm, "$1- when: a caller asks")
        .replaceAll(/^(\s*)expect: "".*$/gm, "$1expect: they are told")
        .replace(/^source: inferred$/m, 'source: "inferred, curated"')
        // One outcome left with no scenario pointing at it.
        .replace(/\n *- when: a caller asks\n.*\n.*409.*$/m, ""),
    );
    fs.copyFileSync(path.join(intent, ROUTE), path.join(short, ROUTE));

    const checked = checkIntent(short);

    const reported = checked.intent.findings.filter(
      (f) => f.kind === "undescribedOutcome",
    );
    expect(reported).toHaveLength(1);
    expect(reported[0].severity).toBe("info");
    expect(reported[0].message).toContain("no PRD scenario says why");
  });

  it("reports a declared write the consumer does not make", () => {
    const drift = driftedInto("write", DRAFT, (doc) =>
      doc.replaceAll("aws.dynamodb:Invoices", "aws.dynamodb:Receipts"),
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

  it("reports a 404 the route produces on the opposite condition", () => {
    const drift = driftedInto("condition", ROUTE, (doc) =>
      doc.replace("        finds: nothing\n", "        finds: something\n"),
    );

    const checked = checkIntent(drift);

    expect(checked.status).toBe(1);
    const reported = checked.intent.findings.filter(
      (f) => f.kind === "uncoveredOutcome",
    );
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain(
      "when reads aws.dynamodb:Invoices finds something",
    );
    expect(reported[0].message).toContain("on a different condition");
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
        "      - writes: aws.dynamodb:Invoices",
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
