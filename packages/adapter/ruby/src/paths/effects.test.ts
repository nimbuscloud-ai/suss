import { describe, expect, it } from "vitest";

import { parseRuby } from "../parser.js";
import { invocationEffects } from "./effects.js";

import type { RbNode } from "../parser.js";

async function effectsFor(lines: string[]) {
  const tree = await parseRuby(lines.join("\n"));
  return invocationEffects(tree.rootNode.namedChildren[0] as RbNode);
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
    const effects = await effectsFor(["def total", "  log(event)", "end"]);
    expect(shape(effects)).toEqual([["log", []]]);
  });

  it("records the test that has to pass for a gated call to run", async () => {
    const effects = await effectsFor([
      "def total",
      "  if discounted",
      "    audit(event)",
      "  end",
      "end",
    ]);
    expect(shape(effects)).toEqual([["audit", ["discounted"]]]);
  });

  it("negates the test for a call after an early return", async () => {
    const effects = await effectsFor([
      "def total",
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
      "def total",
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
      "def total",
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
      "def total",
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
      "def total",
      "  Order.where(id: 1).limit(10).update(name: x)",
      "end",
    ]);
    expect(effects.map((effect) => effect.callee)).toEqual([
      "Order.where(id: 1).limit(10).update",
    ]);
  });
});
