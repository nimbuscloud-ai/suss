import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { Finding } from "@suss/behavioral-ir";
import type { CheckIntentResult } from "@suss/checker-intent";

/**
 * What a queue consumer reads off a message, checked against what the
 * producers on that queue send.
 *
 * Three queues, one case each. PaidQueue's producer sends `data.id`
 * where the consumer reads `data.invoiceId`, which throws on every
 * message and which nothing in the types catches, because what goes
 * over a queue is a string. VoidedQueue agrees. RefundedQueue's consumer
 * passes the message on whole, so its read list is not the whole story
 * and the check keeps quiet about it.
 */
describe("check what a consumer reads against what producers send", () => {
  const summaries = workspace("message-payload-drift");

  const reportFile = path.join(summaries, "report.json");

  const received = (): Finding[] => {
    const run = runSuss([
      "check",
      "--dir",
      summaries,
      "--json",
      "-o",
      reportFile,
    ]);
    expect(run.status, run.stderr).toBe(0);
    const report = readJson(reportFile) as { findings: Finding[] };
    return report.findings.filter(
      (f) => f.kind === "boundaryFieldUnknown" && f.aspect === "receive",
    );
  };

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "--dir",
      fixture("message-payload-drift"),
      "-f",
      "aws-lambda",
      "-f",
      "aws-sqs",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("message-payload-drift"), "template.yaml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);
  }, 120_000);

  it("reports the field the producer renamed, and only that one", () => {
    const findings = received();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("PaidWorkerFunction.handler");
    expect(findings[0]?.description).toContain('reads "data.invoiceId"');
    expect(findings[0]?.description).toContain("PaidQueue");
    expect(findings[0]?.severity).toBe("warning");
  });

  it("says nothing about the queue whose two sides agree", () => {
    expect(
      received().filter((f) => f.description.includes("VoidedQueue")),
    ).toEqual([]);
  });

  it("says nothing about the consumer that passes the message on whole", () => {
    expect(
      received().filter((f) => f.description.includes("RefundedQueue")),
    ).toEqual([]);
  });

  /**
   * The consumer's behaviour and the queue that reaches it come from
   * two files, and one document has to say both. The template gives the
   * channel, the handler gives the outcomes, and the pair of them is
   * what a person curates.
   */
  describe("intent drafted for a queue nothing in the code names", () => {
    const intent = path.join(summaries, "intent");

    beforeAll(() => {
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

    it("writes one document per queue, on the queue's own channel", () => {
      // Each producer is a Lambda the template deploys, so it gets a
      // document of its own beside the queue it publishes to.
      expect(fs.readdirSync(intent).sort()).toEqual([
        "bus-aws-sqs-paid-queue.intent.yaml",
        "bus-aws-sqs-refunded-queue.intent.yaml",
        "bus-aws-sqs-voided-queue.intent.yaml",
        "unit-lambda-paid-producer-function.intent.yaml",
        "unit-lambda-refunded-producer-function.intent.yaml",
        "unit-lambda-voided-producer-function.intent.yaml",
      ]);

      const doc = fs.readFileSync(
        path.join(intent, "bus-aws-sqs-paid-queue.intent.yaml"),
        "utf8",
      );
      expect(doc).toContain("channel: PaidQueue");
      expect(doc).toContain("when: invoiceId is not a string");
      expect(doc).toContain("src/handlers/paidWorker.ts");
    });

    it("takes the curated documents back without an argument", () => {
      for (const file of fs.readdirSync(intent)) {
        const at = path.join(intent, file);
        fs.writeFileSync(
          at,
          fs
            .readFileSync(at, "utf8")
            .replace(/^purpose: "".*$/m, "purpose: Record what arrived.")
            .replace(/^audience: "".*$/m, "audience: the billing team")
            .replace(/^source: inferred$/m, 'source: "inferred, curated"'),
        );
      }

      const run = runSuss([
        "check",
        "--dir",
        summaries,
        "--intent",
        intent,
        "--json",
      ]);
      const report = JSON.parse(run.stdout) as { intent: CheckIntentResult };

      expect(report.intent.findings).toEqual([]);
      expect(report.intent.unchecked).toEqual([]);
      expect(
        report.intent.checked.map((one) =>
          one.kind === "boundary" ? one.boundary : one.intent,
        ),
      ).toEqual([
        "bus:aws_sqs PaidQueue",
        "bus:aws_sqs RefundedQueue",
        "bus:aws_sqs VoidedQueue",
        "unit:lambda PaidProducerFunction",
        "unit:lambda RefundedProducerFunction",
        "unit:lambda VoidedProducerFunction",
      ]);
    });
  });
});
