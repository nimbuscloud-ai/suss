import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  activeJobTestPack,
  sidekiqTestPack,
} from "./__fixtures__/jobPatterns.js";
import { railsTestPack } from "./__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";

const root = path.resolve(__dirname, "../../../../fixtures/ruby-jobs");

const models: RubyPack = {
  name: "activerecord",
  protocol: "postgresql",
  discovery: [],
  storage: [
    {
      baseClasses: ["ActiveRecord::Base"],
      writes: ["create!", "update!"],
      reads: ["find", "where", "first"],
      givesBack: ["find", "where", "first"],
      storageSystem: "postgresql",
    },
  ],
};

async function extract(
  packs: RubyPack[] = [activeJobTestPack(), sidekiqTestPack()],
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [
      railsTestPack({
        routesFor: (_controller, action) => [
          {
            method: action === "create" ? "POST" : "PATCH",
            path: `/exports/${action}`,
          },
        ],
      }),
      models,
      ...packs,
    ],
    workspaceRoot: root,
  });
  return summaries;
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

function sends(summary: BehavioralSummary | undefined): Effect[] {
  return (summary?.transitions ?? [])
    .flatMap((transition) => transition.effects)
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "message-send",
    );
}

function channelsOf(
  summary: BehavioralSummary | undefined,
): Array<string | null> {
  return [
    ...new Set(
      sends(summary).map((effect) =>
        effect.type === "interaction" &&
        effect.binding.semantics.name === "message-bus"
          ? effect.binding.semantics.channel
          : null,
      ),
    ),
  ];
}

describe("background jobs in Ruby", () => {
  it("makes each job's perform a consumer on the job and the queue it declares", async () => {
    const summaries = await extract();
    const job = named(summaries, "ReportExportJob#perform");
    const worker = named(summaries, "PushWorker#perform");

    expect(job?.kind).toBe("consumer");
    expect(job?.identity.boundaryBinding?.semantics).toEqual({
      name: "message-bus",
      messageBus: "activejob",
      channel: "exports#ReportExportJob",
    });
    expect(worker?.identity.boundaryBinding?.semantics).toEqual({
      name: "message-bus",
      messageBus: "sidekiq",
      channel: "push#PushWorker",
    });
  });

  it("gives the job's reads and writes to the job", async () => {
    const job = named(await extract(), "ReportExportJob#perform");
    const tables = (job?.transitions ?? [])
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access"
          ? [
              `${effect.interaction.kind} ${effect.binding.semantics.name === "storage" ? effect.binding.semantics.container : ""}`,
            ]
          : [],
      );
    expect(tables).toEqual(
      expect.arrayContaining(["read AsyncFileExport", "write AsyncFileExport"]),
    );
  });

  it("makes each public message of a mailer a consumer, and leaves a private method out", async () => {
    const summaries = await extract();
    expect(
      named(summaries, "UserMailer#export_ready")?.identity.boundaryBinding
        ?.semantics,
    ).toMatchObject({ channel: "UserMailer.export_ready" });
    expect(named(summaries, "UserMailer#helper_thing")).toBeUndefined();
  });

  it("records each enqueue as a send to the job, with the job's arguments", async () => {
    const create = (await extract()).find(
      (summary) =>
        summary.kind === "handler" && summary.identity.name === "create",
    );
    expect(channelsOf(create)).toEqual([
      "ReportExportJob",
      "PushWorker",
      "UserMailer.export_ready",
      null,
    ]);
    const later = sends(create).find(
      (effect) =>
        effect.type === "interaction" &&
        effect.callee === "PushWorker.perform_in",
    );
    expect(
      later?.type === "interaction" &&
        later.interaction.class === "message-send"
        ? later.interaction.body
        : undefined,
    ).toEqual({
      kind: "array",
      items: [{ kind: "identifier", name: "export.id" }],
    });
  });

  it("leaves a gap where the job an enqueue runs is not settled", async () => {
    const create = (await extract()).find(
      (summary) =>
        summary.kind === "handler" && summary.identity.name === "create",
    );
    expect(create?.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "job_class.perform_later",
      }),
    );
  });

  it("runs an inherited perform as the job that inherits it", async () => {
    const summaries = await extract();
    const inherited = named(summaries, "AccountRawDistributionWorker#perform");
    expect(inherited?.kind).toBe("consumer");
    expect(inherited?.location.file).toBe(
      "app/workers/raw_distribution_worker.rb",
    );
    expect(inherited?.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "AccountRawDistributionWorker",
    });
  });

  it("reads an enqueue in one of the job's own class methods as that job", async () => {
    expect(channelsOf(named(await extract(), "enqueue_for"))).toEqual([
      "RawDistributionWorker",
    ]);
  });

  it("settles no job where the job has no perform, the mailer is unsettled, or the call has no receiver", async () => {
    const summaries = await extract();
    const destroy = summaries.find(
      (summary) =>
        summary.kind === "handler" && summary.identity.name === "destroy",
    );
    expect(channelsOf(destroy)).toEqual([null, "CleanupWorker"]);
    expect((destroy?.gaps ?? []).map((gap) => gap.callee).sort()).toEqual(
      expect.arrayContaining([
        "NoopJob.perform_later",
        "mailer_class.export_ready(export).deliver_later",
        "perform_later",
      ]),
    );
    expect(
      sends(destroy).some(
        (effect) =>
          effect.type === "interaction" &&
          effect.callee === "Notifier.welcome(export).deliver_later",
      ),
    ).toBe(false);
    expect(named(summaries, "NoopJob#perform")).toBeUndefined();
    expect(named(summaries, "UserMailer#initialize")).toBeUndefined();
  });

  it("reads a module included from the top level, and a job with no queue of its own", async () => {
    expect(
      named(await extract(), "CleanupWorker#perform")?.identity.boundaryBinding
        ?.semantics,
    ).toMatchObject({ messageBus: "sidekiq", channel: "CleanupWorker" });
  });

  it("follows a project's own perform_later on a class that is no job", async () => {
    const summaries = await extract();
    const update = summaries.find(
      (summary) =>
        summary.kind === "handler" && summary.identity.name === "update",
    );
    expect(channelsOf(update)).toEqual(["AccountRawDistributionWorker"]);
    expect(named(summaries, "perform_later")?.kind).toBe("library");
  });

  it("finds no job and records no send when no job pack is in the run", async () => {
    const summaries = await extract([]);
    expect(summaries.filter((summary) => summary.kind === "consumer")).toEqual(
      [],
    );
    expect(summaries.flatMap((summary) => sends(summary))).toEqual([]);
  });
});
