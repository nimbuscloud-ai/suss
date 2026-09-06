import { describe, expect, it } from "vitest";

import { parseRuby } from "../parser.js";
import { invocationEffects } from "./effects.js";

import type { RbNode } from "../parser.js";

async function effectsFor(lines: string[], inherited?: ReadonlySet<string>) {
  const tree = await parseRuby(lines.join("\n"));
  return invocationEffects(tree.rootNode.namedChildren[0] as RbNode, inherited);
}

/** The callee of each invocation, with the conditions gating it. */
function shape(effects: Awaited<ReturnType<typeof effectsFor>>) {
  return effects.map((effect) => [
    effect.callee,
    (effect.preconditions ?? []).map(
      (condition) =>
        `${condition.polarity === "negative" ? "!" : ""}${condition.sourceText}`,
    ),
  ]);
}

describe("ruby invocation effects", () => {
  it("records a call the body always makes", async () => {
    const effects = await effectsFor([
      "def total(event)",
      "  log(event)",
      "end",
    ]);
    expect(shape(effects)).toEqual([["log", []]]);
  });

  it("records the test that has to pass for a gated call to run", async () => {
    const effects = await effectsFor([
      "def total(discounted, event)",
      "  if discounted",
      "    audit(event)",
      "  end",
      "end",
    ]);
    expect(shape(effects)).toEqual([["audit", ["discounted"]]]);
  });

  it("negates the test for a call after an early return", async () => {
    const effects = await effectsFor([
      "def total(discounted, event)",
      "  if discounted",
      "    audit(event)",
      "    return 1",
      "  end",
      "  publish(event)",
      "end",
    ]);
    expect(shape(effects)).toEqual([
      ["audit", ["discounted"]],
      ["publish", ["!discounted"]],
    ]);
  });

  it("writes the receiver into the callee, the way it is written", async () => {
    const effects = await effectsFor([
      "def total(metrics, name)",
      "  metrics.increment(name)",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["metrics.increment"]);
  });

  it("leaves a property read out, since it does no work", async () => {
    const effects = await effectsFor(["def total", "  object.total", "end"]);
    expect(effects).toEqual([]);
  });

  it("leaves a raise out, since it leaves the method rather than doing work", async () => {
    const effects = await effectsFor([
      "def total",
      "  raise ArgumentError",
      "end",
    ]);
    expect(effects).toEqual([]);
  });

  it("writes a literal argument out and keeps a name as a name", async () => {
    const effects = await effectsFor([
      "def total",
      "  publish('orders', count, 3, :symbol, true)",
      "end",
    ]);
    expect(effects[0]?.args).toEqual([
      { kind: "string", value: "orders" },
      { kind: "identifier", name: "count" },
      { kind: "number", value: 3 },
      { kind: "string", value: "symbol" },
      { kind: "boolean", value: true },
    ]);
  });

  it("reads a keyword argument's value rather than the keyword", async () => {
    const effects = await effectsFor([
      "def total",
      "  publish(queue: 'orders')",
      "end",
    ]);
    expect(effects[0]?.args).toEqual([{ kind: "string", value: "orders" }]);
  });

  it("keeps a call written inside a block, because it runs in this method", async () => {
    const effects = await effectsFor([
      "def total",
      "  items.each do |item|",
      "    publish(item)",
      "  end",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toContain("publish");
  });

  it("leaves a nested method's calls to that method", async () => {
    const effects = await effectsFor(["def total", "  outer()", "end"]);
    expect(shape(effects).map((row) => row[0])).toEqual(["outer"]);
  });

  it("claims nothing for a body that calls nothing", async () => {
    const effects = await effectsFor(["def total", "  1", "end"]);
    expect(effects).toEqual([]);
  });
  it("writes a float and a false out too", async () => {
    const effects = await effectsFor([
      "def total",
      "  publish(1.5, false)",
      "end",
    ]);
    expect(effects[0]?.args).toEqual([
      { kind: "number", value: 1.5 },
      { kind: "boolean", value: false },
    ]);
  });

  it("reads a nested call as an argument of its own", async () => {
    const effects = await effectsFor([
      "def total",
      "  publish(build(x))",
      "end",
    ]);
    const outer = effects.find((effect) => effect.callee === "publish");
    expect(outer?.args[0]).toEqual({
      kind: "call",
      callee: "build",
      args: [{ kind: "identifier", name: "x" }],
    });
  });

  it("claims nothing for a node with no body", async () => {
    const tree = await parseRuby("x = 1\n");
    expect(invocationEffects(tree.rootNode.namedChildren[0] as RbNode)).toEqual(
      [],
    );
  });

  it("keeps a call gated by a case arm", async () => {
    const effects = await effectsFor([
      "def total(kind, one)",
      "  case kind",
      "  when 1",
      "    publish(one)",
      "  end",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["publish"]);
  });
  it("keeps only what every path to a call agrees on", async () => {
    const effects = await effectsFor([
      "def total(a, b, one, two)",
      "  if a",
      "    send(one)",
      "  end",
      "  if b",
      "    send(two)",
      "  end",
      "end",
    ]);
    expect(shape(effects)).toEqual([
      ["send", ["a"]],
      ["send", ["b"]],
    ]);
  });

  it("counts a method chain once, as the outermost call", async () => {
    const effects = await effectsFor([
      "def total(x)",
      "  Order.where(id: 1).limit(10).update(name: x)",
      "end",
    ]);
    expect(effects.map((effect) => effect.callee)).toEqual([
      "Order.where(id: 1).limit(10).update",
    ]);
  });

  it("records a bare name the method never binds as the call it is", async () => {
    const effects = await effectsFor([
      "def index",
      "  render json: visible_items",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual([
      "render",
      "visible_items",
    ]);
  });

  it("records a bare name written as a statement of its own", async () => {
    const effects = await effectsFor(["def index", "  refresh_cache", "end"]);
    expect(shape(effects).map((row) => row[0])).toEqual(["refresh_cache"]);
  });

  it("gates a bare call the same way it gates any other", async () => {
    const effects = await effectsFor([
      "def index",
      "  if stale?",
      "    refresh_cache",
      "  end",
      "end",
    ]);
    expect(shape(effects)).toEqual([
      ["stale?", []],
      ["refresh_cache", ["stale?"]],
    ]);
  });

  it("reads a name the method assigns as a local variable, not a call", async () => {
    const effects = await effectsFor([
      "def index",
      "  items = load",
      "  render json: items",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["load", "render"]);
  });

  it("reads a name assigned below the read as a local variable too", async () => {
    const effects = await effectsFor([
      "def index",
      "  render json: items",
      "  items = []",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["render"]);
  });

  it("reads a block parameter and a rescue variable as local variables", async () => {
    const effects = await effectsFor([
      "def index",
      "  begin",
      "    rows.each { |row| publish(row) }",
      "  rescue StandardError => err",
      "    report(err)",
      "  end",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["publish", "report"]);
  });

  it("reads a for loop's variable as a local variable", async () => {
    const effects = await effectsFor([
      "def index",
      "  for row in rows",
      "    publish(row)",
      "  end",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["rows", "publish"]);
  });

  it("reads a parameter with a default, a splat and a block as local variables", async () => {
    const effects = await effectsFor([
      "def index(page = 1, *rest, **opts, &blk)",
      "  page",
      "  rest",
      "  opts",
      "  blk",
      "end",
    ]);
    expect(effects).toEqual([]);
  });

  it("reads every name a destructuring binds as a local variable", async () => {
    const effects = await effectsFor([
      "def index",
      "  first, second = pair",
      "  rows.each { |(key, value)| publish(key, value, first, second) }",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["pair", "publish"]);
  });

  it("leaves a name out where it is being spelled rather than read", async () => {
    const effects = await effectsFor([
      "def index",
      "  def helper",
      "  end",
      "  alias fetch load",
      "  undef stale",
      "  refresh_cache",
      "end",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["refresh_cache"]);
  });

  it("leaves a bare raise out, the same as a raise with an argument", async () => {
    const effects = await effectsFor(["def index", "  raise", "end"]);
    expect(effects).toEqual([]);
  });

  it("leaves out a call to a method a pack said the library defines", async () => {
    const effects = await effectsFor(
      ["def index", "  list_items(params[:id])", "end"],
      new Set(["params"]),
    );
    expect(shape(effects).map((row) => row[0])).toEqual(["list_items"]);
  });

  it("leaves out a declared method written with arguments of its own", async () => {
    const effects = await effectsFor(
      ["def index", "  render json: list_items", "end"],
      new Set(["render"]),
    );
    expect(shape(effects).map((row) => row[0])).toEqual(["list_items"]);
  });

  it("records a declared name written against a receiver", async () => {
    const effects = await effectsFor(
      ["def index", "  ReportPage.render(json: 1)", "end"],
      new Set(["render"]),
    );
    expect(shape(effects).map((row) => row[0])).toEqual(["ReportPage.render"]);
  });

  it("records a bare name no pack declared", async () => {
    const effects = await effectsFor(
      ["def index", "  visible_items", "end"],
      new Set(["params"]),
    );
    expect(shape(effects).map((row) => row[0])).toEqual(["visible_items"]);
  });
});
