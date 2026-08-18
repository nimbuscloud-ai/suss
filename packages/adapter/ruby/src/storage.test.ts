import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { storageEffects } from "./storage.js";

import type { RbStoragePattern } from "./pack.js";
import type { RbNode } from "./parser.js";

const ACTIVE_RECORD: RbStoragePattern = {
  baseClasses: ["ActiveRecord::Base"],
  writes: ["update", "destroy", "save", "create", "delete_all"],
  storageSystem: "postgresql",
};

/** Rails puts its own base class between the library and every model. */
const MODELS = [
  "class ApplicationRecord < ActiveRecord::Base",
  "end",
  "",
  "class Order < ApplicationRecord",
  "end",
  "",
].join("\n");

function callsIn(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsIn(child, found);
  }
  return found;
}

async function effectsFor(source: string, models = MODELS) {
  const db = new Database();
  const constants = [];
  let root: RbNode | null = null;
  for (const [file, text] of Object.entries({
    "models.rb": models,
    "use.rb": source,
  })) {
    const tree = await parseRuby(text);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
    if (file === "use.rb") {
      root = tree.rootNode;
    }
  }
  emitConstantBindings(db, constants);

  return storageEffects(callsIn(root as RbNode), {
    facts: db,
    patterns: [ACTIVE_RECORD],
  });
}

const accessOf = (effect: unknown) =>
  effect !== undefined &&
  (effect as { type: string }).type === "interaction" &&
  (effect as { interaction: { class: string } }).interaction.class ===
    "storage-access"
    ? (effect as { interaction: Record<string, unknown> }).interaction
    : null;

describe("the database work a Ruby body does", () => {
  it("reads a call on a model two classes below the library's own base", async () => {
    const effects = await effectsFor("found = Order.where(id: 1).first\n");

    expect(effects).toHaveLength(1);
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      operation: "first",
      selector: ["id"],
    });
  });

  it("says which model the call was against", async () => {
    const effects = await effectsFor("found = Order.where(id: 1).first\n");
    const [effect] = effects;
    const semantics =
      effect?.type === "interaction" ? effect.binding.semantics : null;
    expect(semantics?.name === "storage" ? semantics.container : null).toBe(
      "Order",
    );
  });

  it("counts a chain once rather than once per call in it", async () => {
    const effects = await effectsFor(
      "found = Order.where(id: 1).limit(10).first\n",
    );
    expect(effects).toHaveLength(1);
  });

  it("reads a chain ending in a write as one", async () => {
    const effects = await effectsFor("Order.where(id: 1).destroy\n");
    expect(accessOf(effects[0])).toMatchObject({ kind: "write" });
  });

  it("says nothing about a class that reaches no base the pack says", async () => {
    const effects = await effectsFor(
      "found = Order.where(id: 1).first\n",
      ["class Order", "end", ""].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("says nothing about a call on something that is not a constant", async () => {
    const effects = await effectsFor("found = orders.where(id: 1).first\n");
    expect(effects).toEqual([]);
  });

  it("says nothing when no pack declares a pattern", async () => {
    const tree = await parseRuby("Order.where(id: 1).first\n");
    expect(
      storageEffects(callsIn(tree.rootNode), {
        facts: new Database(),
        patterns: [],
      }),
    ).toEqual([]);
  });

  it("stops rather than going round classes that extend each other", async () => {
    const effects = await effectsFor(
      "found = Order.where(id: 1).first\n",
      ["class Order < Loop", "end", "", "class Loop < Order", "end", ""].join(
        "\n",
      ),
    );
    expect(effects).toEqual([]);
  });

  it("says nothing about a name two files declare", async () => {
    const db = new Database();
    const constants = [];
    let root: RbNode | null = null;
    for (const [file, text] of Object.entries({
      "one.rb": "class Order < ApplicationRecord\nend\n",
      "two.rb": "class Order\nend\n",
      "models.rb": MODELS,
      "use.rb": "found = Order.where(id: 1).first\n",
    })) {
      const tree = await parseRuby(text);
      emitValueFacts(db, file, tree.rootNode);
      constants.push(collectFileConstants(file, tree.rootNode));
      if (file === "use.rb") {
        root = tree.rootNode;
      }
    }
    emitConstantBindings(db, constants);

    expect(
      storageEffects(callsIn(root as RbNode), {
        facts: db,
        patterns: [ACTIVE_RECORD],
      }),
    ).toEqual([]);
  });
});
