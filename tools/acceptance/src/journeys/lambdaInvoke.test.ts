import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

/**
 * One Lambda calling another, with nothing in the template to say so.
 *
 * The invoker writes `FunctionName: process.env.REPORT_BUILDER_FUNCTION`
 * and the template sets that variable to `!Ref ReportBuilder`, so the
 * pair only appears once both files are in the run. The third invoke
 * names a function by full ARN that this stack does not deploy, which
 * is a call reaching outside what suss read.
 */
describe("one Lambda invoking another", () => {
  const summaries = workspace("lambda-invoke");
  const codeFile = path.join(summaries, "code.json");
  const infraFile = path.join(summaries, "infra.json");
  const reportFile = path.join(summaries, "report.json");
  // `inspect` renders one file, and the pair only exists once the code
  // and the template are both in it.
  const together = path.join(workspace("lambda-invoke-all"), "all.json");

  interface Report {
    findings: Finding[];
    pairs: Array<{ key: string; provider: string; consumer: string }>;
  }

  const report = (): Report => {
    const run = runSuss([
      "check",
      "--dir",
      summaries,
      "--json",
      "-o",
      reportFile,
    ]);
    expect(run.status, run.stderr).toBe(0);
    return readJson(reportFile) as Report;
  };

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "--dir",
      fixture("lambda-invoke"),
      "-f",
      "aws-lambda",
      "-o",
      codeFile,
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("lambda-invoke"), "template.yaml"),
      "-o",
      infraFile,
    ]);
    expect(infra.status, infra.stderr).toBe(0);

    fs.writeFileSync(
      together,
      JSON.stringify([
        ...(readJson(codeFile) as BehavioralSummary[]),
        ...(readJson(infraFile) as BehavioralSummary[]),
      ]),
    );
  }, 120_000);

  it("pairs the invoker with the function it names through an env var", () => {
    const keys = report().pairs.map((p) => p.key);
    expect(keys).toContain("unit:lambda ReportBuilder");
    expect(keys).toContain("unit:lambda ArchiveWorker");
  });

  it("says which summary is on each side of the pair", () => {
    const pair = report().pairs.find(
      (p) => p.key === "unit:lambda ReportBuilder",
    );
    expect(pair?.provider).toContain("ReportBuilder.handler");
    expect(pair?.consumer).toContain("OrderApi.handler");
  });

  it("reports the invoke whose target this stack does not deploy", () => {
    const findings = report().findings.filter(
      (f) => f.kind === "unitInvocationTargetUnknown",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("legacy-pricing");
    expect(findings[0]?.severity).toBe("warning");
  });

  it("says which function invokes an invoked one", () => {
    const run = runSuss(["inspect", together]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "Nothing in the template routes an event here. It is invoked by OrderApi.handler.",
    );
  });

  it("still says nothing in the run invokes OrderApi", () => {
    const run = runSuss(["inspect", together]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("outside what suss read");
  });

  it("counts an invoked function as having a client", () => {
    const run = runSuss(["inspect", "--dir", summaries]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("unit:lambda ReportBuilder");
    expect(run.stdout).toContain("client:   OrderApi.handler");
    expect(run.stdout).not.toContain("ReportBuilder.handler (unit:lambda");
  });
});
