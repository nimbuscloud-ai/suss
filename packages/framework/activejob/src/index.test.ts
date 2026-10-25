import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";

import { activeJobFramework, declares, optionsSchema } from "./index.js";

const root = path.resolve(__dirname, "../../../../fixtures/ruby-jobs");

describe("activeJobFramework", () => {
  it("reads jobs and mailers, and discovers nothing through a discovery pattern", () => {
    const pack = activeJobFramework();
    expect(pack.discovery).toEqual([]);
    expect(pack.jobs?.map((pattern) => pattern.type)).toEqual([
      "jobClasses",
      "mailers",
    ]);
  });

  it("makes a job's perform and a mailer's message consumers of an activejob channel", async () => {
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(root),
      packs: [activeJobFramework()],
      workspaceRoot: root,
    });
    const channels = summaries
      .filter((summary) => summary.kind === "consumer")
      .map((summary) => summary.identity.boundaryBinding?.semantics)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(channels).toEqual([
      {
        name: "message-bus",
        messageBus: "activejob",
        channel: "exports#ReportExportJob",
      },
      {
        name: "message-bus",
        messageBus: "activejob",
        channel: "UserMailer.export_ready",
      },
    ]);
  });

  it("takes no options, and suggests itself to a Rails app", () => {
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ queues: [] }).success).toBe(false);
    expect(declares.dependencies).toContainEqual({
      ecosystem: "rubygems",
      name: "rails",
    });
  });
});
