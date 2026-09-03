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
        "cancel",
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

  it("gives every bound action the pattern's default status code", async () => {
    const { summaries } = await extractFixture();
    const index = action(summaries, "orders_controller", "index");
    expect(index.transitions[0]?.output).toMatchObject({
      type: "response",
      statusCode: { type: "literal", value: 200 },
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
