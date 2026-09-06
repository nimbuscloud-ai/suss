import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { withActiveRecord } from "@suss/framework-activerecord";

import { railsFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-rails");
const appRoot = path.join(fixtureRoot, "app");

async function extractFixture() {
  const files = findRubyFiles(appRoot);
  const pack = withActiveRecord(
    railsFramework({
      root: appRoot,
      routesFile: path.join(fixtureRoot, "config/routes.rb"),
    }),
    { storageSystem: "postgresql" },
  );
  return extractRubyProject({
    files,
    packs: [pack],
    workspaceRoot: fixtureRoot,
  });
}

/** The one discovered action with `name`, written in a file whose path contains `fileIncludes`. Several controllers in this fixture share action names, so a lookup by name alone would pick whichever file the walk visited first. */
function action(
  summaries: BehavioralSummary[],
  fileIncludes: string,
  name: string,
): BehavioralSummary {
  const found = summaries.find(
    (s) =>
      s.kind === "handler" &&
      s.identity.name === name &&
      s.location.file.includes(fileIncludes),
  );
  expect(found, `${fileIncludes}#${name}`).toBeDefined();
  return found as BehavioralSummary;
}

describe("extraction over fixtures/ruby-rails", () => {
  it("discovers every action a controller defines, routed or not", async () => {
    const { summaries } = await extractFixture();
    const actionNames = summaries
      .filter((s) => s.kind === "handler")
      .map((s) => s.identity.name)
      .sort();
    // OrdersController, ItemsController and Admin::ReportsController each
    // define their own index, so the name repeats across three units.
    expect(actionNames).toEqual(
      [
        "index",
        "index",
        "index",
        "show",
        "show",
        "show",
        "update",
        "update",
        "archive",
        "cancel",
        "create",
        "destroy",
        "summary",
        "preview",
      ].sort(),
    );
  });

  it("binds a conventional resources action at its method and path", async () => {
    const { summaries } = await extractFixture();
    const index = action(summaries, "orders_controller", "index");
    expect(index.identity.boundaryBinding).toMatchObject({
      semantics: { name: "rest", method: "GET", path: "/orders" },
    });
  });

  it("binds show, the other conventional action the controller defines", async () => {
    const { summaries } = await extractFixture();
    const show = action(summaries, "orders_controller", "show");
    expect(show.identity.boundaryBinding).toMatchObject({
      semantics: { name: "rest", method: "GET", path: "/orders/:id" },
    });
  });

  it("binds a member route to the action it names", async () => {
    const { summaries } = await extractFixture();
    const cancel = action(summaries, "orders_controller", "cancel");
    expect(cancel.identity.boundaryBinding).toMatchObject({
      semantics: { name: "rest", method: "POST", path: "/orders/:id/cancel" },
    });
  });

  it("binds a bare get ... to: route at its own literal path", async () => {
    const { summaries } = await extractFixture();
    const summary = action(summaries, "orders_controller", "summary");
    expect(summary.identity.boundaryBinding).toMatchObject({
      semantics: {
        name: "rest",
        method: "GET",
        path: "/orders/:id/summary",
      },
    });
  });

  it("gives an action that writes no status of its own Rails' own default", async () => {
    const { summaries } = await extractFixture();
    const index = action(summaries, "orders_controller", "index");
    expect(index.transitions[0]?.output).toMatchObject({
      type: "response",
      statusCode: { type: "literal", value: 200 },
    });
  });

  it("reads the status a render call gives, written as a Rack symbol", async () => {
    const { summaries } = await extractFixture();
    const create = action(summaries, "items_controller", "create");
    expect(create.transitions[0]?.output).toMatchObject({
      type: "response",
      statusCode: { type: "literal", value: 201 },
    });
  });

  it("reports one transition per branch an action responds on", async () => {
    const { summaries } = await extractFixture();
    const update = action(summaries, "items_controller", "update");
    expect(
      update.transitions.map((transition) => transition.output),
    ).toMatchObject([
      { type: "response", statusCode: { type: "literal", value: 422 } },
      { type: "response", statusCode: { type: "literal", value: 200 } },
    ]);
  });

  it("gates each of those transitions on the test the action branched on", async () => {
    const { summaries } = await extractFixture();
    const update = action(summaries, "items_controller", "update");
    expect(update.transitions[0]?.conditions).toMatchObject([
      { type: "opaque", sourceText: "params[:name].blank?" },
    ]);
    expect(update.transitions[1]?.conditions).toMatchObject([
      {
        type: "negation",
        operand: { type: "opaque", sourceText: "params[:name].blank?" },
      },
    ]);
  });

  it("puts a call written in one arm on that arm's transition alone", async () => {
    const { summaries } = await extractFixture();
    const update = action(summaries, "items_controller", "update");
    expect(update.transitions[0]?.effects).toEqual([]);
    expect(
      update.transitions[1]?.effects.map((effect) =>
        effect.type === "invocation" ? effect.callee : effect.type,
      ),
    ).toEqual(["OrderService.new.list_items"]);
  });

  it("gives an action that only redirects the 302 a redirect sends", async () => {
    const { summaries } = await extractFixture();
    const archive = action(summaries, "items_controller", "archive");
    expect(archive.identity.boundaryBinding).toMatchObject({
      semantics: {
        name: "rest",
        method: "POST",
        path: "/orders/:order_id/items/:id/archive",
      },
    });
    expect(archive.transitions).toHaveLength(1);
    expect(archive.transitions[0]?.output).toMatchObject({
      type: "response",
      statusCode: { type: "literal", value: 302 },
    });
  });

  it("reads the status a head call gives", async () => {
    const { summaries } = await extractFixture();
    const destroy = action(summaries, "items_controller", "destroy");
    expect(destroy.transitions[0]?.output).toMatchObject({
      type: "response",
      statusCode: { type: "literal", value: 204 },
    });
  });

  it("leaves an action the routes file never reaches unbound, calls still followed", async () => {
    const { summaries } = await extractFixture();
    const preview = action(summaries, "orders_controller", "preview");
    expect(preview.identity.boundaryBinding).toBeNull();
    expect(preview.transitions[0]?.effects.length).toBeGreaterThan(0);
  });

  it("records config/routes.rb's mount declaration as one gap, not repeated per action", async () => {
    const { summaries } = await extractFixture();
    const gapMessages = summaries.flatMap((s) =>
      s.gaps
        .map((g) => g.description)
        .filter((description) => description.includes("mount")),
    );
    expect(gapMessages).toHaveLength(1);
    expect(gapMessages[0]).toContain("routes.rb");
  });

  it("reaches ActiveRecord storage two calls below a bound action", async () => {
    const { summaries } = await extractFixture();
    const index = action(summaries, "orders_controller", "index");
    expect(
      index.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "invocation" && effect.callee.includes("list_orders"),
      ),
    ).toBe(true);

    const service = summaries.find(
      (s) => s.kind === "library" && s.identity.name === "list_orders",
    );
    expect(service).toBeDefined();
    expect(
      service?.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "interaction" &&
          effect.binding.semantics.name === "storage" &&
          effect.binding.semantics.storageSystem === "postgresql" &&
          effect.binding.semantics.container === "Order",
      ),
    ).toBe(true);
  });

  it("reaches a private helper an action calls by its bare name", async () => {
    const { summaries } = await extractFixture();
    const show = action(summaries, "items_controller", "show");
    expect(
      show.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "invocation" &&
          effect.callee.includes("visible_items"),
      ),
    ).toBe(true);

    const helper = summaries.find(
      (s) => s.kind === "library" && s.identity.name === "visible_items",
    );
    expect(helper).toBeDefined();
    expect(
      helper?.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "invocation" && effect.callee.includes("list_items"),
      ),
    ).toBe(true);
  });

  it("leaves the methods Rails defines off an action's effects", async () => {
    const { summaries } = await extractFixture();
    const index = action(summaries, "items_controller", "index");
    const callees = (index.transitions[0]?.effects ?? [])
      .filter((effect) => effect.type === "invocation")
      .map((effect) => effect.callee);
    expect(callees).toEqual(["OrderService.new.list_items"]);
  });

  it("leaves render and head off an action's effects while still reading their status", async () => {
    const { summaries } = await extractFixture();
    const create = action(summaries, "items_controller", "create");
    const callees = (create.transitions[0]?.effects ?? [])
      .filter((effect) => effect.type === "invocation")
      .map((effect) => effect.callee);
    expect(callees).toEqual(["OrderService.new.list_items"]);
    expect(create.transitions[0]?.output).toMatchObject({
      statusCode: { type: "literal", value: 201 },
    });
  });

  it("binds a resource nested one level inside another, with the parent's own id param", async () => {
    const { summaries } = await extractFixture();
    const itemsIndex = action(summaries, "items_controller", "index");
    expect(itemsIndex.identity.boundaryBinding).toMatchObject({
      semantics: {
        name: "rest",
        method: "GET",
        path: "/orders/:order_id/items",
      },
    });
  });

  it("binds a singular resource's actions with no :id, on the plural controller", async () => {
    const { summaries } = await extractFixture();
    expect(
      action(summaries, "profiles_controller", "show").identity.boundaryBinding,
    ).toMatchObject({
      semantics: { name: "rest", method: "GET", path: "/profile" },
    });
    expect(
      action(summaries, "profiles_controller", "update").identity
        .boundaryBinding,
    ).toMatchObject({
      semantics: { name: "rest", method: "PATCH", path: "/profile" },
    });
  });

  it("binds the namespaced action under its module and path prefix", async () => {
    const { summaries } = await extractFixture();
    const reportsIndex = action(summaries, "admin/reports_controller", "index");
    expect(reportsIndex.identity.boundaryBinding).toMatchObject({
      semantics: { name: "rest", method: "GET", path: "/admin/reports" },
    });
  });

  it("does not discover a private controller method as an action", async () => {
    const { summaries } = await extractFixture();
    expect(
      summaries.some(
        (s) => s.kind === "handler" && s.identity.name === "authorize_order!",
      ),
    ).toBe(false);
  });

  it("still gives a private controller method a summary once the action that calls it is reached", async () => {
    const { summaries } = await extractFixture();
    const cancel = action(summaries, "orders_controller", "cancel");
    expect(
      cancel.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "invocation" &&
          effect.callee.includes("authorize_order!"),
      ),
    ).toBe(true);

    const helper = summaries.find(
      (s) => s.kind === "library" && s.identity.name === "authorize_order!",
    );
    expect(helper).toBeDefined();
    expect(
      helper?.transitions[0]?.effects.some(
        (effect) =>
          effect.type === "invocation" && effect.callee.includes("find_order"),
      ),
    ).toBe(true);
  });
});
