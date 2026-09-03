/**
 * A graphql-ruby field's resolver reaching the database two calls
 * away, through the pipeline a user runs: extract with a graphql-ruby
 * pack that also knows ActiveRecord, write the summaries out, then ask
 * what the field reaches. The answer has to come from the summaries
 * alone, so the service method the resolver calls needs a summary of
 * its own and the call has to say which summary it lands on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";

import { answerQuestion } from "./ask.js";
import { functionOf, readCallFacts } from "./callFacts.js";
import { relativizeSummaryPaths } from "./extract.js";
import { touchesOfUnits } from "./target.js";

import type { RubyPack } from "@suss/adapter-ruby";
import type { BehavioralSummary } from "@suss/behavioral-ir";

let dir: string;

const graphqlWithActiveRecord: RubyPack = {
  name: "graphql-ruby",
  protocol: "http-graphql",
  discovery: [
    {
      type: "graphqlObjectFields",
      baseClassNames: ["Types::BaseObject"],
      root: "/app/graphql",
      pathConvention: "railsUnderscore",
      fieldCallName: "field",
      typeCallName: "type",
      argumentCallName: "argument",
      wiringKeywords: ["mutation", "resolver"],
      resolverMethodName: "resolve",
      ancestryRootClassNames: [
        "GraphQL::Schema::Object",
        "GraphQL::Schema::Mutation",
        "GraphQL::Schema::Resolver",
      ],
      requiredKeyword: "required",
      requiredDefault: true,
      camelizeKeyword: "camelize",
      camelizeDefault: true,
      scalars: { String: { type: "text" } },
      scalarNamePrefixes: [],
      typeNameConvention: "stripTypeSuffix",
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-reach-cli-"));
  write("app/graphql/types/query_type.rb", [
    "class Types::QueryType < Types::BaseObject",
    "  field :orders, String, null: false",
    "",
    "  def orders",
    "    OrderService.new.list_orders(current_user)",
    "  end",
    "end",
  ]);
  write("app/services/order_service.rb", [
    "class OrderService",
    "  def list_orders(user)",
    "    Order.where(user_id: user.id)",
    "  end",
    "end",
  ]);
  write("app/models/application_record.rb", [
    "class ApplicationRecord < ActiveRecord::Base",
    "end",
  ]);
  write("app/models/order.rb", ["class Order < ApplicationRecord", "end"]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

async function extracted(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(dir),
    packs: [graphqlWithActiveRecord],
    projectRoot: dir,
  });
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, dir);
  }
  return summaries;
}

describe("what a graphql-ruby field's resolver reaches", () => {
  it("finds the database one call below the field through the call facts", async () => {
    const summaries = await extracted();
    const field = summaries.find(
      (summary) => summary.identity.name === "Query.orders",
    );
    expect(field).toBeDefined();

    const facts = readCallFacts(summaries);
    const reached = facts.reachedFrom([functionOf(field as BehavioralSummary)]);
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
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what does Query.orders reach",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(answer?.headline).toContain("reaches 1 boundary");
    expect(text).toContain("reads postgresql:ActiveRecord::Base/Order");
  });

  it("walks the chain for a why question, and says the chained call has no proof of its own", async () => {
    const summaries = await extracted();
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode } = answerQuestion({
      question:
        "why does Query.orders reach postgresql:ActiveRecord::Base/Order",
      dir: out,
      project: dir,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(text).toContain(
      "Query.orders -> OrderService.new.list_orders -> Order.where",
    );
    expect(text).toContain(
      "calls OrderService.new.list_orders, and that call runs list_orders",
    );
    expect(text).toContain("without their resolution steps");
  });

  it("finds the field from the service method it calls", async () => {
    const summaries = await extracted();
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
    expect(text).toContain("Query.orders");
  });
});

describe("what a graphql-ruby field's resolver reaches through a method passed by name", () => {
  beforeEach(() => {
    write("app/graphql/types/index_type.rb", [
      "class Types::IndexType < Types::BaseObject",
      "  field :build_result, String, null: false",
      "",
      "  def build_result",
      "    register(method(:build_index))",
      "  end",
      "end",
    ]);
    write("app/lib/register.rb", [
      "def build_index",
      "  Order.where(user_id: 1)",
      "end",
      "",
      "def register(handler)",
      "  handler.call",
      "end",
    ]);
  });

  it("finds the caller of build_index through register, not just the field", async () => {
    const summaries = await extracted();
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what calls build_index",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    expect(answer?.headline).toContain("1 unit calls");
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(text).toContain("register");
  });

  it("no longer ends at the parameter: register's own gap is gone, and the field reaches the boundary through it", async () => {
    const summaries = await extracted();
    const register = summaries.find(
      (summary) => summary.identity.name === "register",
    );
    expect(
      register?.gaps.filter((gap) => gap.type === "unfollowedCall"),
    ).toEqual([]);

    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what does Index.buildResult reach",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    expect(answer?.headline).toContain("reaches 1 boundary");
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(text).toContain("reads postgresql:ActiveRecord::Base/Order");
  });
});
