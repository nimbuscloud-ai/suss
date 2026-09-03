import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { graphqlRubyTestPack } from "../__fixtures__/graphqlRubyPattern.js";
import { extractRubyProject, findRubyFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "../pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-reach-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

/** A graphql-ruby object type declaring one field, its resolver method holding `bodyLines`. */
function writeQueryType(fieldName: string, bodyLines: string[]): void {
  write("app/graphql/types/query_type.rb", [
    "class Types::QueryType < Types::BaseObject",
    `  field :${fieldName}, String, null: false`,
    "",
    `  def ${fieldName}`,
    ...bodyLines.map((line) => `    ${line}`),
    "  end",
    "end",
  ]);
}

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [
      graphqlRubyTestPack({
        root: path.join(tmpDir, "app", "graphql"),
      }) as RubyPack,
    ],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

function unitNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary is named ${name}`);
  }
  return found;
}

function calls(
  summary: BehavioralSummary,
): Array<[string, string | undefined]> {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation"
        ? [[effect.callee, effect.summary] as [string, string | undefined]]
        : [],
    ),
  );
}

describe("the methods a graphql-ruby field's resolver reaches", () => {
  it("gives a service method the resolver calls a library summary and links the call to it", async () => {
    writeQueryType("orders", ["OrderService.new.list_orders(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    Order.where(user_id: user.id)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(helper.kind).toBe("library");
    expect(helper.location.file).toBe("app/services/order_service.rb");
    expect(helper.identity.exportPath).toEqual(["OrderService", "list_orders"]);
    expect(helper.identity.boundaryBinding).toMatchObject({
      transport: "in-process",
      semantics: { name: "function-call" },
      recognition: "reachable",
    });

    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([
      ["OrderService.new.list_orders", summaryIdentifier(helper)],
    ]);
  });

  it("follows a helper into the helper it calls", async () => {
    writeQueryType("orders", ["OrderService.new.list_orders(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    totaled(user)",
      "  end",
      "end",
      "",
      "def totaled(user)",
      "  user.orders.count",
      "end",
    ]);

    const summaries = await extract();
    const service = unitNamed(summaries, "list_orders");
    const helper = unitNamed(summaries, "totaled");
    expect(service.kind).toBe("library");
    expect(helper.kind).toBe("library");
    expect(helper.identity.exportPath).toEqual(["totaled"]);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["OrderService.new.list_orders", summaryIdentifier(service)],
    ]);
    expect(calls(service)).toEqual([["totaled", summaryIdentifier(helper)]]);
  });

  it("records a bare call to a method on the field's own type through self", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders",
      "    load_orders(current_user)",
      "  end",
      "",
      "  def load_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "load_orders");
    expect(helper.identity.exportPath).toEqual([
      "Types::QueryType",
      "load_orders",
    ]);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["load_orders", summaryIdentifier(helper)],
    ]);
  });

  it("follows a class method called straight on the constant to its own def self.", async () => {
    writeQueryType("orders", ["OrderService.call(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def self.call(user)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "call");
    expect(helper.kind).toBe("library");
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["OrderService.call", summaryIdentifier(helper)],
    ]);
  });

  it("follows a wired field's resolver the same way a plain field's is followed", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, resolver: Queries::OrdersQuery",
      "end",
    ]);
    write("app/graphql/queries/orders_query.rb", [
      "class Queries::OrdersQuery < Queries::BaseQuery",
      "  def resolve",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(helper.kind).toBe("library");
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["OrderService.new.list_orders", summaryIdentifier(helper)],
    ]);
  });

  it("leaves a dynamic send as an unfollowed call", async () => {
    writeQueryType("orders", ["send(:load_orders, current_user)"]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["send", undefined]]);
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "send",
        description: expect.stringContaining("could not settle"),
      }),
    );
  });

  it("leaves a call into a class this run never defines as an unfollowed call with no gap", async () => {
    writeQueryType("orders", ["Rails.cache.delete(current_user)"]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["Rails.cache.delete", undefined]]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("leaves a method defined with define_method as an unfollowed call", async () => {
    writeQueryType("orders", ["OrderService.new.list_orders(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  define_method(:list_orders) { |user| user.orders }",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "OrderService.new.list_orders",
      }),
    );
  });

  it("leaves a bare name two files each define at the top level as an unfollowed call", async () => {
    writeQueryType("orders", ["totaled(current_user)"]);
    write("app/lib/first.rb", ["def totaled(user)", "  1", "end"]);
    write("app/lib/second.rb", ["def totaled(user)", "  2", "end"]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "totaled",
        description: expect.stringContaining("more than one possible source"),
      }),
    );
  });

  it("mints one summary for a helper two fields both reach", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "  field :recent_orders, String, null: false",
      "",
      "  def orders",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "",
      "  def recent_orders",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helpers = summaries.filter(
      (summary) => summary.identity.name === "list_orders",
    );
    expect(helpers).toHaveLength(1);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
    expect(calls(unitNamed(summaries, "Query.recentOrders"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
  });

  it("shares one seed when two wired fields point at the same resolver", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, resolver: Queries::OrdersQuery",
      "end",
    ]);
    write("app/graphql/types/mutation_type.rb", [
      "class Types::MutationType < Types::BaseObject",
      "  field :order_list, resolver: Queries::OrdersQuery",
      "end",
    ]);
    write("app/graphql/queries/orders_query.rb", [
      "class Queries::OrdersQuery < Queries::BaseQuery",
      "  def resolve",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helpers = summaries.filter(
      (summary) => summary.identity.name === "list_orders",
    );
    expect(helpers).toHaveLength(1);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
    expect(calls(unitNamed(summaries, "Mutation.orderList"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
  });

  it("lists a reached method's parameters by position", async () => {
    writeQueryType("orders", ["OrderService.new.list_orders(current_user, 5)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user, limit = 10)",
      "    user.orders.first(limit)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(
      helper.inputs.map((input) =>
        input.type === "parameter" ? input.name : null,
      ),
    ).toEqual(["user", "limit"]);
  });

  it("leaves a bare call to a method nothing here declares as unfollowed with no gap", async () => {
    writeQueryType("orders", ["puts(current_user)"]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["puts", undefined]]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("stops at a call on a local value this run has no binder for", async () => {
    writeQueryType("orders", [
      "user = current_user",
      "user.notify(current_user)",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["user.notify", undefined]]);
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "user.notify",
      }),
    );
  });

  it("resolves a class written as a namespaced path", async () => {
    writeQueryType("orders", [
      "Billing::OrderService.new.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "module Billing",
      "  class OrderService",
      "    def list_orders(user)",
      "      user.orders",
      "    end",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(helper.identity.exportPath).toEqual([
      "Billing::OrderService",
      "list_orders",
    ]);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["Billing::OrderService.new.list_orders", summaryIdentifier(helper)],
    ]);
  });

  it("leaves a class method nothing here declares as unfollowed", async () => {
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def self.call(user)",
      "    user.orders",
      "  end",
      "end",
      "",
      "# Reopened with nothing in it, ordinary Ruby.",
      "class OrderService; end",
    ]);
    writeQueryType("orders", ["OrderService.build(current_user)"]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("drops an anonymous splat from a reached method's positional parameters", async () => {
    writeQueryType("orders", ["OrderService.new.list_orders(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user, *)",
      "    user.orders",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(
      helper.inputs.map((input) =>
        input.type === "parameter" ? input.name : null,
      ),
    ).toEqual(["user"]);
  });

  it("stops at .new called on something other than a known class", async () => {
    writeQueryType("orders", ["service_class.new.list_orders(current_user)"]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([
      ["service_class.new.list_orders", undefined],
    ]);
  });

  it("stops at a proc called with the implicit .() syntax", async () => {
    writeQueryType("orders", ["current_user.()"]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
  });

  it("reaches a method passed by name to a helper that calls it through a parameter", async () => {
    writeQueryType("orders", ["register(method(:build_index))"]);
    write("app/lib/register.rb", [
      "def build_index",
      "  1",
      "end",
      "",
      "def register(handler)",
      "  handler.call",
      "end",
    ]);

    const summaries = await extract();
    const buildIndex = unitNamed(summaries, "build_index");
    expect(buildIndex.kind).toBe("library");

    const field = unitNamed(summaries, "Query.orders");
    const passing = field.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "register");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toEqual({ "0": buildIndex.identity.id });

    const register = unitNamed(summaries, "register");
    const called = register.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "handler.call");
    expect(
      called?.type === "invocation" ? called.calleeParameter : undefined,
    ).toBe(0);
    expect(
      register.gaps.filter(
        (gap) => gap.type === "unfollowedCall" && gap.callee === "handler.call",
      ),
    ).toHaveLength(0);
  });

  it("reaches a method passed by name as an &-prefixed block argument", async () => {
    writeQueryType("orders", ["apply(1, &method(:build_index))"]);
    write("app/lib/apply.rb", [
      "def build_index(x)",
      "  x",
      "end",
      "",
      "def apply(x, &blk)",
      "  blk.call(x)",
      "end",
    ]);

    const summaries = await extract();
    const buildIndex = unitNamed(summaries, "build_index");
    expect(buildIndex.kind).toBe("library");

    const field = unitNamed(summaries, "Query.orders");
    const passing = field.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "apply");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toEqual({ "1": buildIndex.identity.id });

    const apply = unitNamed(summaries, "apply");
    const called = apply.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "blk.call");
    expect(
      called?.type === "invocation" ? called.calleeParameter : undefined,
    ).toBe(1);
  });

  it("gaps a call through a parameter nothing here passes a method into", async () => {
    writeQueryType("orders", ["apply { 1 }"]);
    write("app/lib/apply.rb", ["def apply(&blk)", "  blk.call", "end"]);

    const summaries = await extract();
    const apply = unitNamed(summaries, "apply");
    const gap = apply.gaps.find(
      (g) => g.type === "unfollowedCall" && g.callee === "blk.call",
    );
    expect(gap).toBeDefined();
    expect(gap?.description).toContain(
      "no caller in this run passes it a function by name",
    );
  });

  it("reaches a method passed by name to a helper that calls it with the .() shorthand", async () => {
    writeQueryType("orders", ["register(method(:build_index))"]);
    write("app/lib/register.rb", [
      "def build_index",
      "  1",
      "end",
      "",
      "def register(handler)",
      "  handler.()",
      "end",
    ]);

    const summaries = await extract();
    const buildIndex = unitNamed(summaries, "build_index");
    const register = unitNamed(summaries, "register");
    const called = register.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "handler.call");
    expect(
      called?.type === "invocation" ? called.calleeParameter : undefined,
    ).toBe(0);
    expect(
      register.gaps.filter((gap) => gap.type === "unfollowedCall"),
    ).toHaveLength(0);
    expect(buildIndex.kind).toBe("library");
  });

  it("gives a reached method with no parameters and no body an empty summary", async () => {
    writeQueryType("orders", ["OrderService.call(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def self.call",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "call");
    expect(helper.inputs).toEqual([]);
    expect(helper.transitions[0]?.effects).toEqual([]);
  });

  it("skips a reopened block that declares no body when scanning for a resolver", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders",
      "    current_user",
      "  end",
      "end",
      "",
      "# Reopened with nothing in it, ordinary Ruby.",
      "class Types::QueryType; end",
    ]);

    const summaries = await extract();
    expect(unitNamed(summaries, "Query.orders").kind).toBe("resolver");
  });
});
