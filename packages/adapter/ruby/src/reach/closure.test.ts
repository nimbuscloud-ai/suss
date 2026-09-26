import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { graphqlRubyTestPack } from "../__fixtures__/graphqlRubyPattern.js";
import { controllerActionsPattern } from "../__fixtures__/railsControllerPattern.js";
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

/**
 * A graphql-ruby object type declaring one field, its resolver method
 * holding `bodyLines`. The resolver takes `current_user` as a parameter
 * so that the body lines below can pass it around as a plain value; a
 * bare name a method never binds is a call on self, and would be read
 * as one.
 */
function writeQueryType(fieldName: string, bodyLines: string[]): void {
  write("app/graphql/types/query_type.rb", [
    "class Types::QueryType < Types::BaseObject",
    `  field :${fieldName}, String, null: false`,
    "",
    `  def ${fieldName}(current_user)`,
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
      "  def orders(current_user)",
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
      "  def resolve(current_user)",
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

  it("leaves a method defined with define_method unfollowed, since no fact says the class has it", async () => {
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
    expect(calls(field)).toEqual([["OrderService.new.list_orders", undefined]]);
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "OrderService.new.list_orders",
        description: expect.stringContaining(
          "lands on a method the project defines with define_method",
        ),
      }),
    );
  });

  it("gaps a call on a name a define_method loop was read to define", async () => {
    writeQueryType("orders", [
      "Form::AdminSettings.new.update_site_title(current_user)",
    ]);
    write("app/forms/admin_settings.rb", [
      "class Form::AdminSettings",
      "  include ActiveModel::Model",
      "",
      "  KEYS = %i(site_title).freeze",
      "",
      "  KEYS.each do |key|",
      '    define_method("update_#{key}") { |value| value }',
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "Form::AdminSettings.new.update_site_title",
        description: expect.stringContaining(
          "lands on a method the project defines with define_method",
        ),
      }),
    );
  });

  it("follows a build past a class whose define_method loop defines no initialize", async () => {
    writeQueryType("orders", ["Form::AdminSettings.new(current_user)"]);
    write("app/forms/admin_settings.rb", [
      "class Form::AdminSettings",
      "  include ActiveModel::Model",
      "",
      "  KEYS = %i(site_title).freeze",
      "",
      "  KEYS.each do |key|",
      "    define_method(key) { 1 }",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
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

  it("follows a call written as a bare name, with no arguments and no parentheses", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders",
      "    visible_orders",
      "  end",
      "",
      "  private",
      "",
      "  def visible_orders",
      "    OrderService.new.list_orders(1)",
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
    const helper = unitNamed(summaries, "visible_orders");
    expect(helper.kind).toBe("library");
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["visible_orders", summaryIdentifier(helper)],
    ]);
    expect(calls(helper).map(([callee]) => callee)).toEqual([
      "OrderService.new.list_orders",
    ]);
  });

  it("follows a bare name written inside another call's arguments", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders",
      "    wrap(visible_orders)",
      "  end",
      "",
      "  def visible_orders",
      "    1",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "visible_orders");
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["wrap", undefined],
      ["visible_orders", summaryIdentifier(helper)],
    ]);
  });

  it("reads a bare name the method assigns as a local variable, so nothing is followed", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders",
      "    visible_orders = 1",
      "    visible_orders",
      "  end",
      "",
      "  def visible_orders",
      "    2",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([]);
    expect(
      summaries.some((summary) => summary.identity.name === "visible_orders"),
    ).toBe(false);
  });

  it("mints one summary for a helper two fields both reach", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "  field :recent_orders, String, null: false",
      "",
      "  def orders(current_user)",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "",
      "  def recent_orders(current_user)",
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
      "  def resolve(current_user)",
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

  it("stops at a call on a local nothing in this run declares a value for", async () => {
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
  });

  it("follows the one write it can read when the other write reaches no class", async () => {
    writeQueryType("orders", [
      "scope = OrderService.new",
      'scope = "text" if current_user',
      "scope.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    // Nothing orders the two writes, so `scope` steps to each of them.
    // The string reaches no class with a `list_orders` on it, and the
    // run stops recording that a source went unread.
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([
      [
        "scope.list_orders",
        "app/services/order_service.rb::OrderService.list_orders",
      ],
    ]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("follows a call on a local a later write narrows with a call on itself", async () => {
    writeQueryType("orders", [
      "scope = OrderService.new",
      "scope = scope.only(1)",
      "scope.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def only(n)",
      "    self",
      "  end",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["only", "list_orders"]);
  });

  it("follows a chain through a method that returns self", async () => {
    writeQueryType("orders", ["OrderService.new.only(1).list_orders(2)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def only(n)",
      "    self",
      "  end",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["list_orders"]);
  });

  it("follows a call on a name aliased through two more", async () => {
    writeQueryType("orders", [
      "a = OrderService.new",
      "b = a",
      "c = b",
      "c.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["list_orders"]);
  });

  it("runs a class's own initialize when the call makes one of it", async () => {
    writeQueryType("orders", ["OrderService.new(current_user)"]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def initialize(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["initialize"]);
  });

  it("reports a call on a local two branches build from different classes", async () => {
    writeQueryType("orders", [
      "scope = OrderService.new",
      "scope = AuditService.new if current_user",
      "scope.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);
    write("app/services/audit_service.rb", [
      "class AuditService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "scope.list_orders",
        description: expect.stringContaining("more than one possible source"),
      }),
    );
  });

  it("runs a method the file declares at the top level when a name calls it", async () => {
    write("app/graphql/types/query_type.rb", [
      "def build_index(user)",
      "  user",
      "end",
      "",
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders(current_user)",
      "    handler = build_index",
      "    handler.call(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["build_index"]);
  });

  it("leaves a name read off a value this file built to the language", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Index",
      "end",
      "",
      "def build_index",
      "  Index.new",
      "end",
      "",
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders(current_user)",
      "    handler = build_index",
      "    handler.arity(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toContainEqual(["handler.arity", undefined]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("stops at a method called on an array, which the language rather than the project declares", async () => {
    writeQueryType("orders", ["rows = []", "rows.push(current_user)"]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["rows.push", undefined]]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("links no method called on a value to a method of the same name in the file, however often it is called", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders(current_user)",
      "    rows = []",
      "    rows.delete(current_user)",
      "    rows.delete(nil)",
      "    delete(current_user)",
      "    self.delete(current_user)",
      "  end",
      "",
      "  def delete(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const own = summaryIdentifier(unitNamed(summaries, "delete"));
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["rows.delete", undefined],
      ["rows.delete", undefined],
      ["delete", own],
      ["self.delete", own],
    ]);
  });

  it("links a bare name two classes in one file call to each class's own method", async () => {
    writeQueryType("orders", [
      "OrderReport.new.render(current_user)",
      "AccountReport.new.render(current_user)",
    ]);
    write("app/services/reports.rb", [
      "class OrderReport",
      "  def render(user)",
      "    helper(user)",
      "  end",
      "",
      "  def helper(user)",
      "    user",
      "  end",
      "end",
      "",
      "class AccountReport",
      "  def render(user)",
      "    helper(user)",
      "  end",
      "",
      "  def helper(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const inClass = (name: string, className: string) =>
      summaries.find(
        (summary) =>
          summary.identity.name === name &&
          summary.identity.exportPath?.[0] === className,
      ) as BehavioralSummary;
    for (const className of ["OrderReport", "AccountReport"]) {
      expect(calls(inClass("render", className))).toEqual([
        ["helper", summaryIdentifier(inClass("helper", className))],
      ]);
    }
  });

  it("links a bare name two class methods call to the class method of that name in the file", async () => {
    writeQueryType("orders", [
      "Trends.register(current_user)",
      "Trends.refresh(current_user)",
      "Trends.tags(current_user)",
    ]);
    write("app/models/trends.rb", [
      "module Trends",
      "  def self.tags(user)",
      "    user",
      "  end",
      "",
      "  def self.register(user)",
      "    tags(user)",
      "  end",
      "",
      "  def self.refresh(user)",
      "    tags(user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const tags = summaryIdentifier(unitNamed(summaries, "tags"));
    expect(calls(unitNamed(summaries, "register"))).toEqual([["tags", tags]]);
    expect(calls(unitNamed(summaries, "refresh"))).toEqual([["tags", tags]]);
  });

  it("follows a bare call in a class method to the class method it runs, which nothing else calls", async () => {
    writeQueryType("orders", ["Trends.register(current_user)"]);
    write("app/models/trends.rb", [
      "module Trends",
      "  def self.links(user)",
      "    user",
      "  end",
      "",
      "  def self.register(user)",
      "    links(user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const links = summaryIdentifier(unitNamed(summaries, "links"));
    expect(calls(unitNamed(summaries, "register"))).toEqual([["links", links]]);
  });

  it("reaches a class method written inside `class << self`, and the class method it calls", async () => {
    writeQueryType("orders", ["ReportFormatter.shorten(current_user)"]);
    write("app/lib/report_formatter.rb", [
      "class ReportFormatter",
      "  class << self",
      "    def shorten(user)",
      "      trim(user)",
      "    end",
      "",
      "    private",
      "",
      "    def trim(user)",
      "      user",
      "    end",
      "  end",
      "",
      "  def shorten(entity)",
      "    entity",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const inLine = (name: string, line: number) =>
      summaries.find(
        (summary) =>
          summary.identity.name === name &&
          summary.location.range.start === line,
      ) as BehavioralSummary;
    const shorten = inLine("shorten", 3);
    expect(shorten.identity.exportPath).toEqual(["ReportFormatter", "shorten"]);
    expect(calls(unitNamed(summaries, "Query.orders"))).toEqual([
      ["ReportFormatter.shorten", summaryIdentifier(shorten)],
    ]);
    expect(calls(shorten)).toEqual([
      ["trim", summaryIdentifier(inLine("trim", 9))],
    ]);
  });

  it("follows a call on a local that a method inside `class << self` assigns", async () => {
    writeQueryType("orders", ["ReportFormatter.shorten(current_user)"]);
    write("app/lib/report_formatter.rb", [
      "class ReportFormatter",
      "  class << self",
      "    def shorten(user)",
      "      service = OrderService.new",
      "      service.list_orders(user)",
      "    end",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(calls(unitNamed(summaries, "shorten"))).toContainEqual([
      "service.list_orders",
      summaryIdentifier(unitNamed(summaries, "list_orders")),
    ]);
  });

  it("links no bare call to a method of the same name that Ruby would not look up from there", async () => {
    writeQueryType("orders", [
      "DomainRule.suspended?(current_user)",
      "DomainRule.new.policies(current_user)",
      "DomainRule.new.stricter?(current_user)",
    ]);
    write("app/models/domain_rule.rb", [
      "class DomainRule",
      "  class << self",
      "    def suspended?(domain)",
      "      stricter?",
      "    end",
      "  end",
      "",
      "  def policies(user)",
      "    suspended?",
      "  end",
      "",
      "  def stricter?(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(calls(unitNamed(summaries, "suspended?"))).toEqual([
      ["stricter?", undefined],
    ]);
    expect(calls(unitNamed(summaries, "policies"))).toEqual([
      ["suspended?", undefined],
    ]);
  });

  it("follows a bare call in a class method of a module that extends itself to its instance method", async () => {
    writeQueryType("orders", ["Formats.render(current_user)"]);
    write("app/lib/formats.rb", [
      "module Formats",
      "  extend self",
      "",
      "  def self.render(user)",
      "    wrap(user)",
      "  end",
      "",
      "  def wrap(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(calls(unitNamed(summaries, "render"))).toEqual([
      ["wrap", summaryIdentifier(unitNamed(summaries, "wrap"))],
    ]);
  });

  it("follows a call on an instance variable another method of the class writes", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def set_scope",
      "    @scope = OrderService.new",
      "  end",
      "",
      "  def orders(current_user)",
      "    @scope.list_orders(current_user)",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["list_orders"]);
  });

  it("follows a call on an instance variable a base class writes", async () => {
    write("app/graphql/types/base_object.rb", [
      "class Types::BaseObject",
      "  def set_scope",
      "    @scope = OrderService.new",
      "  end",
      "end",
    ]);
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def orders(current_user)",
      "    @scope.list_orders(current_user)",
      "  end",
      "end",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["list_orders"]);
  });

  it("reports an instance variable two methods build from different classes", async () => {
    write("app/graphql/types/query_type.rb", [
      "class Types::QueryType < Types::BaseObject",
      "  field :orders, String, null: false",
      "",
      "  def one",
      "    @scope = OrderService.new",
      "  end",
      "",
      "  def two",
      "    @scope = AuditService.new",
      "  end",
      "",
      "  def orders(current_user)",
      "    @scope.list_orders(current_user)",
      "  end",
      "end",
    ]);
    for (const name of ["order_service", "audit_service"]) {
      write(`app/services/${name}.rb`, [
        `class ${name === "order_service" ? "OrderService" : "AuditService"}`,
        "  def list_orders(user)",
        "    user",
        "  end",
        "end",
      ]);
    }

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(field.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "@scope.list_orders",
        description: expect.stringContaining("more than one possible source"),
      }),
    );
  });

  it("reads a call written inside parentheses through them", async () => {
    writeQueryType("orders", [
      "scope = (",
      "  OrderService.new",
      ")",
      "scope.list_orders(current_user)",
    ]);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(
      summaries
        .filter((summary) => summary.kind === "library")
        .map((summary) => summary.identity.name),
    ).toEqual(["list_orders"]);
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

  it("follows a call written with no arguments through an alias chain", async () => {
    writeQueryType("orders", ["a = Entity.new", "b = a", "c = b", "c.run"]);
    write("app/services/entity.rb", [
      "class Entity",
      "  def run",
      "    1",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "run");
    expect(helper.kind).toBe("library");
    expect(helper.identity.exportPath).toEqual(["Entity", "run"]);

    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([["c.run", summaryIdentifier(helper)]]);
  });

  it("reads a no-argument call on a receiver nothing settles as a property read", async () => {
    writeQueryType("orders", ["config.host"]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("says nothing about a no-argument call whose class declares no such method", async () => {
    writeQueryType("orders", ["entity = Entity.new", "entity.name"]);
    write("app/services/entity.rb", [
      "class Entity",
      "  attr_reader :name",
      "end",
    ]);

    const summaries = await extract();
    const field = unitNamed(summaries, "Query.orders");
    expect(calls(field)).toEqual([]);
    expect(field.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("reports the gap a define_method stop gives a no-argument call", async () => {
    writeQueryType("orders", ["entity = Entity.new", "entity.run"]);
    write("app/services/entity.rb", [
      "class Entity",
      "  define_method(:run) { 1 }",
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
        callee: "entity.run",
      }),
    );
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

/**
 * Rails' own vocabulary for a controller and a model, the same values a
 * project's pack config would supply. `givesBack` is what ActiveRecord
 * declares, and none of those methods is written anywhere in the run.
 */
function railsWithModels(): RubyPack {
  return {
    name: "rails",
    protocol: "http",
    discovery: [
      controllerActionsPattern({
        root: path.join(tmpDir, "app", "controllers"),
        filters: [
          {
            name: "before_action",
            methodFrom: "argument",
            skippedBy: "skip_before_action",
            actionKeywords: { include: "only", exclude: "except" },
          },
        ],
      }),
    ],
    storage: [
      {
        baseClasses: ["ActiveRecord::Base"],
        writes: ["update", "save", "destroy"],
        reads: ["find", "where", "first"],
        givesBack: ["find", "where", "first"],
        byPrimaryKey: { methods: ["find"], column: "id" },
        storageSystem: "postgresql",
      },
    ],
  };
}

async function extractRails(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [railsWithModels()],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

/** The three events this library's writes run, and the calls a model registers a method under. */
const MODEL_CALLBACKS = {
  eventOf: {
    save: ["create", "update"],
    update: ["update"],
    destroy: ["destroy"],
  },
  registeredBy: {
    before_save: ["create", "update"],
    after_commit: ["create", "update", "destroy"],
    after_destroy: ["destroy"],
  },
  eventKeyword: "on",
};

async function extractRailsWithCallbacks(): Promise<BehavioralSummary[]> {
  const pack = railsWithModels();
  const [storage] = pack.storage ?? [];
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [
      { ...pack, storage: [{ ...storage, callbacks: MODEL_CALLBACKS }] },
    ] as RubyPack[],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

/** A controller whose one action writes through `Account`. */
function writeThroughAccount(line: string): void {
  write("app/controllers/accounts_controller.rb", [
    "class AccountsController < ApplicationController",
    "  def suspend",
    `    ${line}`,
    "  end",
    "end",
  ]);
}

describe("the callbacks a write through a model runs", () => {
  it("puts each registered method on the body that did the write", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  before_save :normalize",
      "",
      "  def normalize",
      "    Audit.where(kind: 'normalize')",
      "  end",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id]).save");

    const summaries = await extractRailsWithCallbacks();
    const action = unitNamed(summaries, "suspend");
    expect(callTo(action, "normalize")).toBe(
      summaryIdentifier(unitNamed(summaries, "normalize")),
    );
  });

  it("leaves one narrowed to another event off a write that does not cause it", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  after_commit :index_account, on: :create",
      "",
      "  def index_account",
      "    Audit.where(kind: 'index')",
      "  end",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id]).update(state: 1)");

    const summaries = await extractRailsWithCallbacks();
    expect(
      summaries.some((summary) => summary.identity.name === "index_account"),
    ).toBe(false);
  });

  it("runs a callback a base class registered on every model below it", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "  after_commit :audit_change",
      "",
      "  def audit_change",
      "    Audit.where(kind: 'change')",
      "  end",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id]).save");

    const summaries = await extractRailsWithCallbacks();
    expect(callTo(unitNamed(summaries, "suspend"), "audit_change")).toBe(
      summaryIdentifier(unitNamed(summaries, "audit_change")),
    );
  });

  it("says nothing about a read, which runs no callback", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  before_save :normalize",
      "",
      "  def normalize",
      "    Audit.where(kind: 'normalize')",
      "  end",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id])");

    const summaries = await extractRailsWithCallbacks();
    expect(
      summaries.some((summary) => summary.identity.name === "normalize"),
    ).toBe(false);
  });

  it("says nothing about a callback written as a block, which names no method", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  after_commit do",
      "    Audit.where(kind: 'commit')",
      "  end",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id]).save");

    const summaries = await extractRailsWithCallbacks();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
  });

  it("says nothing when the pack declares no callbacks at all", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  before_save :normalize",
      "",
      "  def normalize",
      "    Audit.where(kind: 'normalize')",
      "  end",
      "end",
    ]);
    writeThroughAccount("Account.find(params[:id]).save");

    const summaries = await extractRails();
    expect(
      summaries.some((summary) => summary.identity.name === "normalize"),
    ).toBe(false);
  });
});

/** `Account`, whose ancestry reaches the library base two classes up, with one method of its own. */
function writeAccountModel(): void {
  write("app/models/application_record.rb", [
    "class ApplicationRecord < ActiveRecord::Base",
    "end",
  ]);
  write("app/models/account.rb", [
    "class Account < ApplicationRecord",
    "  def suspend_account(reason)",
    "    update(suspended: true, reason: reason)",
    "  end",
    "end",
  ]);
}

/** The database work a summary reports, as what each access says it did. */
function storageAccessesOf(
  summary: BehavioralSummary,
): Array<Record<string, unknown>> {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access"
        ? [
            {
              kind: effect.interaction.kind,
              operation: effect.interaction.operation,
              ...(effect.interaction.selector === undefined
                ? {}
                : { selector: effect.interaction.selector }),
            },
          ]
        : [],
    ),
  );
}

/** The call an action makes, and the summary it was linked to. */
function callTo(
  summary: BehavioralSummary,
  callee: string,
): string | undefined {
  return calls(summary).find(([name]) => name === callee)?.[1];
}

/** A loader that runs the read in `fetch` on the source class it is picked with. */
const BATCH_LOADER = {
  loader: "dataloader",
  pick: "with",
  reads: ["load", "load_all"],
  shortcuts: ["dataload_record"],
  source: { at: 0, method: "fetch" },
};

async function extractWithLoader(
  loader: unknown = BATCH_LOADER,
): Promise<BehavioralSummary[]> {
  const pack = graphqlRubyTestPack({
    root: path.join(tmpDir, "app", "graphql"),
  }) as RubyPack;
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [{ ...pack, loaders: [loader] } as RubyPack],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

/** A source class whose `fetch` reads through a method of its own. */
function writeCampaignSource(): void {
  write("app/graphql/sources/campaign_source.rb", [
    "class Sources::CampaignSource < GraphQL::Dataloader::Source",
    "  def fetch(ids)",
    "    active_for(ids)",
    "  end",
    "",
    "  def active_for(ids)",
    "    Campaign.where(id: ids)",
    "  end",
    "end",
  ]);
}

describe("a read a loader takes off the caller", () => {
  it("reaches the method the library runs on the picked source", async () => {
    writeQueryType("campaigns", [
      "dataloader.with(Sources::CampaignSource, Campaign).load(current_user)",
    ]);
    writeCampaignSource();

    const summaries = await extractWithLoader();
    const fetch = unitNamed(summaries, "fetch");
    expect(fetch.kind).toBe("library");
    expect(
      callTo(
        unitNamed(summaries, "Query.campaigns"),
        "dataloader.with(Sources::CampaignSource, Campaign).load",
      ),
    ).toBe(summaryIdentifier(fetch));
  });

  it("carries on into what that method itself calls", async () => {
    writeQueryType("campaigns", [
      "dataloader.with(Sources::CampaignSource, Campaign).load(current_user)",
    ]);
    writeCampaignSource();

    const summaries = await extractWithLoader();
    expect(callTo(unitNamed(summaries, "fetch"), "active_for")).toBe(
      summaryIdentifier(unitNamed(summaries, "active_for")),
    );
  });

  it("reaches nothing through a loader whose pack says no source", async () => {
    writeQueryType("campaigns", [
      "dataloader.with(Sources::CampaignSource, Campaign).load(current_user)",
    ]);
    writeCampaignSource();

    const { source: _dropped, ...noSource } = BATCH_LOADER;
    const summaries = await extractWithLoader(noSource);
    expect(summaries.some((summary) => summary.identity.name === "fetch")).toBe(
      false,
    );
  });

  it("reaches nothing when the source class is not one this run defines", async () => {
    writeQueryType("campaigns", [
      "dataloader.with(Sources::Absent, Campaign).load(current_user)",
    ]);
    writeCampaignSource();

    const summaries = await extractWithLoader();
    expect(
      callTo(
        unitNamed(summaries, "Query.campaigns"),
        "dataloader.with(Sources::Absent, Campaign).load",
      ),
    ).toBeUndefined();
  });
});

describe("a call on what an ActiveRecord finder gave back", () => {
  it("follows a method read off an instance variable a before_action set", async () => {
    writeAccountModel();
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  before_action :set_account",
      "",
      "  def suspend",
      "    @account.suspend_account(params[:reason])",
      "  end",
      "",
      "  def set_account",
      "    @account = Account.find(params[:id])",
      "  end",
      "end",
    ]);

    const summaries = await extractRails();
    const model = summaries.find(
      (summary) => summary.location.file === "app/models/account.rb",
    );
    expect(model?.identity.exportPath).toEqual(["Account", "suspend_account"]);
    const action = summaries.find(
      (summary) => summary.identity.exportPath?.[1] === "suspend",
    );
    expect(
      callTo(action as BehavioralSummary, "@account.suspend_account"),
    ).toBe(summaryIdentifier(model as BehavioralSummary));
  });

  it("follows a method read off a local a relation chain narrowed to one", async () => {
    writeAccountModel();
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  def suspend",
      "    account = Account.where(handle: params[:handle]).first",
      "    account.suspend_account(params[:reason])",
      "  end",
      "end",
    ]);

    const summaries = await extractRails();
    const model = summaries.find(
      (summary) => summary.location.file === "app/models/account.rb",
    );
    expect(model?.identity.exportPath).toEqual(["Account", "suspend_account"]);
    const action = summaries.find(
      (summary) => summary.identity.exportPath?.[0] === "AccountsController",
    );
    expect(callTo(action as BehavioralSummary, "account.suspend_account")).toBe(
      summaryIdentifier(model as BehavioralSummary),
    );
  });

  it("says nothing about the receiver when the pack declares no such method", async () => {
    writeAccountModel();
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  def suspend",
      "    account = Account.sample(params[:handle])",
      "    account.suspend_account(params[:reason])",
      "  end",
      "end",
    ]);

    const summaries = await extractRails();
    const action = summaries.find(
      (summary) => summary.identity.exportPath?.[0] === "AccountsController",
    );
    expect(
      callTo(action as BehavioralSummary, "account.suspend_account"),
    ).toBeUndefined();
  });

  it("follows a class method the project declares rather than calling it database work", async () => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord < ActiveRecord::Base",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account < ApplicationRecord",
      "  def self.suspend_all(reason)",
      "    where(reason: reason).first",
      "  end",
      "end",
    ]);
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  def suspend",
      "    Account.suspend_all(params[:reason])",
      "  end",
      "end",
    ]);

    const summaries = await extractRails();
    const model = summaries.find(
      (summary) => summary.location.file === "app/models/account.rb",
    );
    const action = summaries.find(
      (summary) => summary.identity.exportPath?.[0] === "AccountsController",
    );
    expect(storageAccessesOf(action as BehavioralSummary)).toEqual([]);
    expect(callTo(action as BehavioralSummary, "Account.suspend_all")).toBe(
      summaryIdentifier(model as BehavioralSummary),
    );
  });

  it("reports no gap for the finder it recorded as a read", async () => {
    writeAccountModel();
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  def show",
      "    Account.find(params[:id])",
      "  end",
      "end",
    ]);

    const summaries = await extractRails();
    const action = summaries.find(
      (summary) => summary.identity.exportPath?.[1] === "show",
    ) as BehavioralSummary;

    expect(storageAccessesOf(action)).toEqual([
      { kind: "read", operation: "find", selector: ["id"] },
    ]);
    expect(action.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });
});

/** The methods a job's entry script calls, written outside every class. */
function writeJobMethods(): void {
  write("app/sync.rb", [
    "def run_report",
    "  Account.where(state: 'stale').first",
    "end",
    "",
    "def build_pool(settings)",
    "  Account.find(settings)",
    "end",
  ]);
}

/** A class whose instance method and class method both read the database. */
function writeReportJob(): void {
  write("app/report_job.rb", [
    "class ReportJob",
    "  def run",
    "    Account.where(state: 'open').first",
    "  end",
    "",
    "  def self.run_nightly",
    "    Account.where(state: 'nightly').first",
    "  end",
    "end",
  ]);
}

/** The module-init unit for a file, which is what the walk scans a file's load-time statements as. */
function moduleInitOf(
  summaries: BehavioralSummary[],
  file: string,
): BehavioralSummary {
  const found = summaries.find(
    (summary) =>
      summary.kind === "module-init" && summary.location.file === file,
  );
  if (found === undefined) {
    throw new Error(`no module-init unit for ${file}`);
  }
  return found;
}

describe("what a file calls when it loads", () => {
  it("reaches a top-level method a bare call at module scope runs", async () => {
    writeAccountModel();
    writeJobMethods();
    write("bin/run_sync.rb", ["run_report"]);

    const summaries = await extractRails();
    const reached = unitNamed(summaries, "run_report");
    expect(reached.kind).toBe("library");
    expect(storageAccessesOf(reached)).toEqual([
      { kind: "read", operation: "first", selector: ["state"] },
    ]);
    expect(
      callTo(moduleInitOf(summaries, "bin/run_sync.rb"), "run_report"),
    ).toBe(summaryIdentifier(reached));
  });

  it("reaches a method run on an instance module scope constructed", async () => {
    writeAccountModel();
    writeReportJob();
    write("bin/run_sync.rb", ["ReportJob.new.run"]);

    const summaries = await extractRails();
    const reached = unitNamed(summaries, "run");
    expect(reached.identity.exportPath).toEqual(["ReportJob", "run"]);
    expect(
      callTo(moduleInitOf(summaries, "bin/run_sync.rb"), "ReportJob.new.run"),
    ).toBe(summaryIdentifier(reached));
  });

  it("reaches a class method module scope calls on the constant", async () => {
    writeAccountModel();
    writeReportJob();
    write("bin/run_sync.rb", ["ReportJob.run_nightly"]);

    const summaries = await extractRails();
    const reached = unitNamed(summaries, "run_nightly");
    expect(
      callTo(
        moduleInitOf(summaries, "bin/run_sync.rb"),
        "ReportJob.run_nightly",
      ),
    ).toBe(summaryIdentifier(reached));
  });

  it("reaches a call written under the guard a script runs itself with", async () => {
    writeAccountModel();
    writeJobMethods();
    write("bin/run_sync.rb", ["if __FILE__ == $0", "  run_report", "end"]);

    const summaries = await extractRails();
    expect(
      callTo(moduleInitOf(summaries, "bin/run_sync.rb"), "run_report"),
    ).toBe(summaryIdentifier(unitNamed(summaries, "run_report")));
  });

  it("reaches a call written as the value a module-scope name is bound to", async () => {
    writeAccountModel();
    writeJobMethods();
    write("bin/run_sync.rb", ["pool = build_pool(1)", "run_report"]);

    const summaries = await extractRails();
    const init = moduleInitOf(summaries, "bin/run_sync.rb");
    expect(callTo(init, "build_pool")).toBe(
      summaryIdentifier(unitNamed(summaries, "build_pool")),
    );
  });

  it("leaves out a call written inside a method the file only declares", async () => {
    writeAccountModel();
    write("bin/run_sync.rb", ["def never_run", "  Account.find(1)", "end"]);

    const summaries = await extractRails();
    expect(summaries.some((s) => s.identity.name === "never_run")).toBe(false);
    expect(summaries.some((s) => s.location.file === "bin/run_sync.rb")).toBe(
      false,
    );
  });

  it("leaves out a call written in a block, whose library decides whether to run it", async () => {
    writeAccountModel();
    writeJobMethods();
    write("bin/run_sync.rb", ["schedule :nightly do", "  run_report", "end"]);

    const summaries = await extractRails();
    expect(summaries.some((s) => s.identity.name === "run_report")).toBe(false);
    expect(summaries.some((s) => s.location.file === "bin/run_sync.rb")).toBe(
      false,
    );
  });

  it("gives an action one summary when module scope calls it as well", async () => {
    writeAccountModel();
    write("app/controllers/accounts_controller.rb", [
      "class AccountsController < ApplicationController",
      "  def refresh",
      "    Account.where(state: 'stale').first",
      "  end",
      "end",
    ]);
    write("bin/run_sync.rb", ["AccountsController.new.refresh"]);

    const summaries = await extractRails();
    const named = summaries.filter((s) => s.identity.name === "refresh");
    expect(named).toHaveLength(1);
    expect(named[0]?.kind).toBe("handler");
    expect(
      callTo(
        moduleInitOf(summaries, "bin/run_sync.rb"),
        "AccountsController.new.refresh",
      ),
    ).toBe(summaryIdentifier(named[0] as BehavioralSummary));
  });

  it("reports no load-time unit for a file whose module scope does nothing", async () => {
    writeAccountModel();
    writeJobMethods();

    const summaries = await extractRails();
    expect(summaries.some((s) => s.kind === "module-init")).toBe(false);
  });
});
