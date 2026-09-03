/**
 * A Rails controller action reaching the database two calls away,
 * through the pipeline a user runs: extract with a Rails-shaped pack
 * that also knows ActiveRecord, write the summaries out, then ask what
 * the action reaches. The answer has to come from the summaries
 * alone, so the service method the action calls needs a summary of
 * its own and the call has to say which summary it lands on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";

import { answerQuestion } from "./ask.js";
import { functionOf, readCallFacts } from "./callFacts.js";
import { relativizeSummaryPaths } from "./extract.js";
import { touchesOfUnits } from "./target.js";

import type { RubyPack } from "@suss/adapter-ruby";
import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../adapter/ruby/src/__fixtures__/railsReachProject",
);

const railsWithActiveRecord: RubyPack = {
  name: "rails",
  protocol: "http",
  discovery: [
    {
      type: "railsControllerAction",
      // Every Rails app scaffolds this class; the library's own base
      // comes one hop further up, past what a project reader can open.
      baseClassNames: ["ApplicationController"],
      root: path.join(fixtureDir, "app/controllers"),
      pathConvention: "railsUnderscore",
      ancestryRootClassNames: [
        "ActionController::Base",
        "ActionController::API",
      ],
      actions: {
        index: { method: "GET", pathTemplate: "/:resource" },
      },
      defaultStatusCode: 200,
    },
  ],
  storage: [
    {
      baseClasses: ["ActiveRecord::Base"],
      writes: ["create", "update", "destroy", "save", "delete_all"],
      storageSystem: "postgresql",
    },
  ],
};

async function extracted(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(fixtureDir),
    packs: [railsWithActiveRecord],
    projectRoot: fixtureDir,
  });
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, fixtureDir);
  }
  return summaries;
}

describe("what a Rails controller action reaches", () => {
  it("finds the database one call below the action through the call facts", async () => {
    const summaries = await extracted();
    const action = summaries.find((summary) => summary.kind === "handler");
    expect(action).toBeDefined();

    const facts = readCallFacts(summaries);
    const reached = facts.reachedFrom([
      functionOf(action as BehavioralSummary),
    ]);
    const paths = [...reached.values()].map((hops) =>
      hops.map((hop) => hop.callee),
    );
    expect(paths).toContainEqual(["OrderService.new.list_orders"]);

    const touched = [...reached.keys()].flatMap((fn) =>
      touchesOfUnits(facts.units.get(fn) ?? []),
    );
    const service = summaries.find(
      (summary) => summary.identity.name === "list_orders",
    );
    expect(service?.kind).toBe("library");
    expect(
      touched
        .filter((touch) => touch.summary === service)
        .map((touch) => touch.touched.label),
    ).toEqual([
      "function-call:reachable",
      "postgresql:ActiveRecord::Base/Order",
    ]);
  });

  it("answers the question the way a user asks it", async () => {
    const summaries = await extracted();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-reach-cli-"));
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what does GET /orders reach",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(answer?.headline).toContain("reaches 1 boundary");
    expect(text).toContain("reads postgresql:ActiveRecord::Base/Order");
  });

  it("walks the chain for a why question without asking TypeScript to prove a Ruby hop", async () => {
    const summaries = await extracted();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-reach-cli-"));
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode } = answerQuestion({
      question:
        "why does GET /orders reach postgresql:ActiveRecord::Base/Order",
      dir: out,
      project: fixtureDir,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(text).toContain(
      "index -> OrderService.new.list_orders -> Order.where",
    );
    expect(text).toContain(
      "calls OrderService.new.list_orders, and that call runs list_orders",
    );
    expect(text).not.toContain("without their resolution steps");
  });

  it("finds the action from the service method it calls", async () => {
    const summaries = await extracted();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-reach-cli-"));
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what calls list_orders",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    expect(answer?.headline).toContain("1 unit calls");
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(text).toContain("OrdersController.index");
  });
});
