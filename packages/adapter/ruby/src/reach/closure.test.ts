import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { railsTestPack } from "../__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "../pack.js";

const APPLICATION_CONTROLLER = [
  "class ApplicationController < ActionController::Base",
  "end",
];

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

function pack(): RubyPack {
  return railsTestPack({ root: path.join(tmpDir, "app/controllers") });
}

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [pack()],
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

describe("the methods a controller action reaches", () => {
  it("gives a service method the action calls a library summary and links the call to it", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    Order.where(user_id: user.id)",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
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

    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([
      ["OrderService.new.list_orders", summaryIdentifier(helper)],
    ]);
  });

  it("follows a helper into the helper it calls", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
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
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const service = unitNamed(summaries, "list_orders");
    const helper = unitNamed(summaries, "totaled");
    expect(service.kind).toBe("library");
    expect(helper.kind).toBe("library");
    expect(helper.identity.exportPath).toEqual(["totaled"]);
    expect(calls(unitNamed(summaries, "index"))).toEqual([
      ["OrderService.new.list_orders", summaryIdentifier(service)],
    ]);
    expect(calls(service)).toEqual([["totaled", summaryIdentifier(helper)]]);
  });

  it("records a bare call to a method on the action's own controller through self", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
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
      "OrdersController",
      "load_orders",
    ]);
    expect(calls(unitNamed(summaries, "index"))).toEqual([
      ["load_orders", summaryIdentifier(helper)],
    ]);
  });

  it("follows a class method called straight on the constant to its own def self.", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def self.call(user)",
      "    user.orders",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.call(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "call");
    expect(helper.kind).toBe("library");
    expect(calls(unitNamed(summaries, "index"))).toEqual([
      ["OrderService.call", summaryIdentifier(helper)],
    ]);
  });

  it("leaves a dynamic send as an unfollowed call", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    send(:load_orders, current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([["send", undefined]]);
    expect(action.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "send",
        description: expect.stringContaining("could not settle"),
      }),
    );
  });

  it("leaves a call into a class this run never defines as an unfollowed call with no gap", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    Rails.cache.delete(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([["Rails.cache.delete", undefined]]);
    expect(action.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("leaves a method defined with define_method as an unfollowed call", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  define_method(:list_orders) { |user| user.orders }",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(action.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "OrderService.new.list_orders",
      }),
    );
  });

  it("leaves a bare name two files each define at the top level as an unfollowed call", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/lib/first.rb", ["def totaled(user)", "  1", "end"]);
    write("app/lib/second.rb", ["def totaled(user)", "  2", "end"]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    totaled(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(action.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "totaled",
        description: expect.stringContaining("more than one possible source"),
      }),
    );
  });

  it("mints one summary for a helper two actions both reach", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "",
      "  def show",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helpers = summaries.filter(
      (summary) => summary.identity.name === "list_orders",
    );
    expect(helpers).toHaveLength(1);
    expect(calls(unitNamed(summaries, "index"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
    expect(calls(unitNamed(summaries, "show"))).toEqual([
      [
        "OrderService.new.list_orders",
        summaryIdentifier(helpers[0] as BehavioralSummary),
      ],
    ]);
  });

  it("lists a reached method's parameters by position", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user, limit = 10)",
      "    user.orders.first(limit)",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user, 5)",
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
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    puts(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([["puts", undefined]]);
    expect(action.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("stops at a call on a local value this run has no binder for", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    user = current_user",
      "    user.notify(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([["user.notify", undefined]]);
    expect(action.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "user.notify",
      }),
    );
  });

  it("resolves a class written as a namespaced path", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "module Billing",
      "  class OrderService",
      "    def list_orders(user)",
      "      user.orders",
      "    end",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    Billing::OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "list_orders");
    expect(helper.identity.exportPath).toEqual([
      "Billing::OrderService",
      "list_orders",
    ]);
    expect(calls(unitNamed(summaries, "index"))).toEqual([
      ["Billing::OrderService.new.list_orders", summaryIdentifier(helper)],
    ]);
  });

  it("shares one seed when two configured patterns discover the same action", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user)",
      "    user.orders",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const { summaries } = await extractRubyProject({
      files: findRubyFiles(tmpDir),
      packs: [
        railsTestPack({ root: path.join(tmpDir, "app/controllers") }),
        railsTestPack({
          root: path.join(tmpDir, "app/controllers"),
          actions: {
            index: { method: "GET", pathTemplate: "/:resource.json" },
          },
        }),
      ],
      workspaceRoot: tmpDir,
    });

    const actions = summaries.filter(
      (summary) => summary.identity.name === "index",
    );
    expect(actions).toHaveLength(2);
    const helper = unitNamed(summaries, "list_orders");
    for (const action of actions) {
      expect(calls(action)).toEqual([
        ["OrderService.new.list_orders", summaryIdentifier(helper)],
      ]);
    }
  });

  it("gives a reached method with no parameters and no body an empty summary", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def self.call",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.call(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "call");
    expect(helper.inputs).toEqual([]);
    expect(helper.transitions[0]?.effects).toEqual([]);
  });

  it("leaves a class method nothing here declares as unfollowed", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
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
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.build(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(action.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });

  it("drops an anonymous splat from a reached method's positional parameters", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/services/order_service.rb", [
      "class OrderService",
      "  def list_orders(user, *)",
      "    user.orders",
      "  end",
      "end",
    ]);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    OrderService.new.list_orders(current_user)",
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
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    service_class.new.list_orders(current_user)",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const action = unitNamed(summaries, "index");
    expect(calls(action)).toEqual([
      ["service_class.new.list_orders", undefined],
    ]);
  });

  it("stops at a proc called with the implicit .() syntax", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    current_user.()",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
  });

  it("skips a reopened block that declares no body when scanning for actions", async () => {
    write("app/controllers/application_controller.rb", APPLICATION_CONTROLLER);
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    current_user",
      "  end",
      "end",
      "",
      "# Reopened with nothing in it, ordinary Ruby.",
      "class OrdersController; end",
    ]);

    const summaries = await extract();
    expect(unitNamed(summaries, "index").kind).toBe("handler");
  });
});
