import { describe, expect, it } from "vitest";

import { parsePython } from "../parser.js";
import { invocationEffects } from "./effects.js";

import type { PyNode } from "../parser.js";

async function effectsFor(lines: string[]) {
  const tree = await parsePython(lines.join("\n"));
  const fn = tree.rootNode.namedChildren[0] as PyNode;
  return invocationEffects(fn);
}

/** The callee of each invocation, with the conditions gating it. */
function shape(effects: Awaited<ReturnType<typeof effectsFor>>) {
  return effects.map((effect) =>
    effect.type === "invocation"
      ? [
          effect.callee,
          (effect.preconditions ?? []).map(
            (condition) =>
              `${condition.polarity === "negative" ? "!" : ""}${condition.sourceText}`,
          ),
        ]
      : [effect.type, []],
  );
}

describe("python invocation effects", () => {
  it("records a call the body always makes, with nothing gating it", async () => {
    const effects = await effectsFor(["def get(self):", "    log(event)"]);
    expect(shape(effects)).toEqual([["log", []]]);
  });

  it("records the test that has to pass for a gated call to run", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    if missing:",
      "        audit(event)",
    ]);
    expect(shape(effects)).toEqual([["audit", ["missing"]]]);
  });

  it("negates the test for a call on the other arm", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    if missing:",
      "        audit(event)",
      "    else:",
      "        publish(event)",
    ]);
    expect(shape(effects)).toEqual([
      ["audit", ["missing"]],
      ["publish", ["!missing"]],
    ]);
  });

  it("keeps only what every path to a call agrees on", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    if a:",
      "        send(one)",
      "    if b:",
      "        send(two)",
    ]);
    expect(shape(effects)).toEqual([
      ["send", ["a"]],
      ["send", ["b"]],
    ]);
  });

  it("writes a literal argument out and keeps a name as a name", async () => {
    const effects = await effectsFor([
      "def get(self):",
      '    publish("orders", count, 3)',
    ]);
    const [effect] = effects;
    expect(effect?.type === "invocation" && effect.args).toEqual([
      { kind: "string", value: "orders" },
      { kind: "identifier", name: "count" },
      { kind: "number", value: 3 },
    ]);
  });

  it("reads a nested call as an argument of its own", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    publish(build(x))",
    ]);
    const outer = effects.find(
      (effect) => effect.type === "invocation" && effect.callee === "publish",
    );
    expect(outer?.type === "invocation" && outer.args[0]).toEqual({
      kind: "call",
      callee: "build",
      args: [{ kind: "identifier", name: "x" }],
    });
  });

  it("leaves a nested function's calls to that function", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    def helper():",
      "        inner()",
      "    outer()",
    ]);
    expect(shape(effects).map((row) => row[0])).toEqual(["outer"]);
  });

  it("claims nothing for a body that calls nothing", async () => {
    const effects = await effectsFor(["def get(self):", "    pass"]);
    expect(effects).toEqual([]);
  });
  it("writes a float and a boolean argument out too", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    publish(1.5, True, False)",
    ]);
    const [effect] = effects;
    expect(effect?.type === "invocation" && effect.args).toEqual([
      { kind: "number", value: 1.5 },
      { kind: "boolean", value: true },
      { kind: "boolean", value: false },
    ]);
  });

  it("reads a keyword argument's value rather than the keyword", async () => {
    const effects = await effectsFor([
      "def get(self):",
      '    publish(queue="orders")',
    ]);
    const [effect] = effects;
    expect(effect?.type === "invocation" && effect.args).toEqual([
      { kind: "string", value: "orders" },
    ]);
  });

  it("claims nothing for a body it cannot read", async () => {
    const tree = await parsePython("x = 1\n");
    const statement = tree.rootNode.namedChildren[0] as PyNode;
    expect(invocationEffects(statement)).toEqual([]);
  });

  it("counts a method chain once, as the outermost call", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    return Orders.query().filter_by(id=1).first()",
    ]);
    expect(effects.map((effect) => effect.callee)).toEqual([
      "Orders.query().filter_by(id=1).first",
    ]);
  });

  it("keeps a call written as an argument separate from the chain around it", async () => {
    const effects = await effectsFor([
      "def get(self):",
      "    return Orders.query().filter_by(id=parse(raw)).first()",
    ]);
    expect(effects.map((effect) => effect.callee)).toEqual([
      "Orders.query().filter_by(id=parse(raw)).first",
      "parse",
    ]);
  });
});
