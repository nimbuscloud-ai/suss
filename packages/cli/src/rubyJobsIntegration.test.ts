/**
 * A Rails app whose routes enqueue ActiveJob jobs, Sidekiq workers and a
 * mailer, through the pipeline a user runs: extract with the job packs,
 * check, then ask what a route reaches. The jobs' work shows up on the
 * jobs, the check pairs each enqueue with its job, and the route's reach
 * goes on into the job.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { checkAll } from "@suss/checker";
import activeJob from "@suss/packs/activejob";
import activeRecord from "@suss/packs/activerecord";
import rails from "@suss/packs/rails";
import sidekiq from "@suss/packs/sidekiq";

import { answerQuestion } from "./ask.js";
import { preloadWhyQuestion } from "./askWhy.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(__dirname, "../../../fixtures/ruby-jobs");

let dir: string;
let summaries: BehavioralSummary[];

beforeAll(async () => {
  ({ summaries } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [
      rails({ configDirectory: root }),
      activeRecord({ storageSystem: "postgresql" }),
      activeJob(),
      sidekiq(),
    ],
    workspaceRoot: root,
  }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-jobs-"));
  fs.writeFileSync(
    path.join(dir, "ruby.json"),
    JSON.stringify(summaries, null, 2),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("background jobs in a Rails app, asked why", () => {
  it("says the route enqueues the job and the job runs it later", async () => {
    await preloadWhyQuestion(root);
    const question = "why does POST /exports reach bus:sidekiq push#PushWorker";
    const { answer } = answerQuestion({
      question,
      dir,
      project: root,
      json: true,
      output: path.join(dir, "why.json"),
    });
    expect(answer?.hops).toEqual([
      expect.objectContaining({
        callee: "PushWorker.perform_async",
        recorded: "sent",
      }),
    ]);

    answerQuestion({
      question,
      dir,
      project: root,
      output: path.join(dir, "why.txt"),
    });
    expect(fs.readFileSync(path.join(dir, "why.txt"), "utf8")).toContain(
      "enqueues PushWorker.perform_async, and PushWorker#perform",
    );
  });
});

describe("background jobs in a Rails app", () => {
  it("pairs each enqueue with the job it runs, and reports no orphan", () => {
    const result = checkAll(summaries);
    const keys = [...new Set(result.pairs.map((pair) => pair.key))].sort();

    expect(keys).toEqual(
      expect.arrayContaining([
        "bus:activejob ReportExportJob",
        "bus:activejob UserMailer.export_ready",
        "bus:sidekiq AccountRawDistributionWorker",
        "bus:sidekiq PushWorker",
        "bus:sidekiq RawDistributionWorker",
      ]),
    );
    expect(
      result.findings.filter((finding) =>
        finding.kind.startsWith("messageBus"),
      ),
    ).toEqual([]);
  });

  it("follows the route into the job it enqueues and says the job runs later", () => {
    const { answer } = answerQuestion({
      question: "what does POST /exports reach",
      dir,
      json: true,
      all: true,
      output: path.join(dir, "answer.txt"),
    });
    const items = (answer?.items ?? []) as Array<{
      boundary: string;
      relations: string[];
      through?: string[];
    }>;

    expect(items).toContainEqual(
      expect.objectContaining({
        boundary: "postgresql:AsyncFileExport",
        relations: ["reads"],
        through: [
          "PushWorker.perform_async, which PushWorker#perform runs later",
        ],
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        boundary: "bus:activejob exports#ReportExportJob",
        through: [
          "ReportExportJob.perform_later, which ReportExportJob#perform runs later",
        ],
      }),
    );
  });
});
