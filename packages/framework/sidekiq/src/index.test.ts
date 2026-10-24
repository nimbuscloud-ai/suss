import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";

import { declares, optionsSchema, sidekiqFramework } from "./index.js";

const root = path.resolve(__dirname, "../../../../fixtures/ruby-jobs");

describe("sidekiqFramework", () => {
  it("makes each Sidekiq job's perform a consumer of a sidekiq channel", async () => {
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(root),
      packs: [sidekiqFramework()],
      workspaceRoot: root,
    });
    const channels = summaries
      .filter((summary) => summary.kind === "consumer")
      .map((summary) => {
        const semantics = summary.identity.boundaryBinding?.semantics;
        return semantics?.name === "message-bus" ? semantics.channel : null;
      })
      .sort();
    expect(channels).toEqual([
      "AccountRawDistributionWorker",
      "CleanupWorker",
      "push#PushWorker",
      "push#RawDistributionWorker",
    ]);
  });

  it("starts perform_in's job arguments after the delay", () => {
    const [pattern] = sidekiqFramework().jobs ?? [];
    expect(
      pattern?.type === "jobClasses" ? pattern.enqueueMethods : undefined,
    ).toMatchObject({ perform_async: 0, perform_in: 1, perform_at: 1 });
  });

  it("takes no options, and suggests itself to a project that depends on sidekiq", () => {
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ queues: [] }).success).toBe(false);
    expect(declares.dependencies).toEqual([
      { ecosystem: "rubygems", name: "sidekiq" },
    ]);
  });
});
