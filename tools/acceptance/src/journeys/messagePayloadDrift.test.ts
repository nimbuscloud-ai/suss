import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { Finding } from "@suss/behavioral-ir";

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
});
