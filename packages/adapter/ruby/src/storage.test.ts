import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { storageClaims, storageEffects } from "./storage.js";

import type { RbLoaderPattern, RbStoragePattern } from "./pack.js";
import type { RbNode } from "./parser.js";

const ACTIVE_RECORD: RbStoragePattern = {
  baseClasses: ["ActiveRecord::Base"],
  writes: ["update", "update!", "destroy", "save", "create", "delete_all"],
  givesBack: ["find", "where", "first"],
  storageSystem: "postgresql",
};

const DATALOADER: RbLoaderPattern = {
  loader: "dataloader",
  pick: "with",
  reads: ["load", "load_all"],
  shortcuts: ["dataload", "dataload_record"],
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

/** The facts a run would have for these files, and the parsed body of `use.rb`. */
async function factsFor(files: Record<string, string>) {
  const db = new Database();
  const constants = [];
  let root: RbNode | null = null;
  for (const [file, text] of Object.entries(files)) {
    const tree = await parseRuby(text);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
    if (file === "use.rb") {
      root = tree.rootNode;
    }
  }
  emitConstantBindings(db, constants);
  return { db, root: root as RbNode };
}

async function effectsFor(source: string, models = MODELS) {
  const { db, root } = await factsFor({
    "models.rb": models,
    "use.rb": source,
  });
  return storageEffects(callsIn(root), "use.rb", {
    facts: db,
    patterns: [ACTIVE_RECORD],
    loaders: [DATALOADER],
  });
}

/** A filter sets the model on an instance variable, and the action writes through it. */
const CONTROLLER = [
  "class OrdersController",
  "  before_action :set_order",
  "",
  "  def set_order",
  "    @order = Order.find(params[:id])",
  "  end",
  "",
  "  def suspend",
  "    @order.update!(suspended_at: Time.now)",
  "  end",
  "end",
  "",
].join("\n");

/** What `emitStorageFacts` puts in a run, which is the only thing that says a finder gives back one of the model. */
function emitGivesBack(db: Database): void {
  for (const method of ACTIVE_RECORD.givesBack) {
    db.add("givesBackOne", ["ActiveRecord::Base", method]);
  }
}

function methodNamed(node: RbNode, name: string): RbNode {
  const found: RbNode[] = [];
  const walk = (current: RbNode): void => {
    if (current.type === "method" && current.text.includes(`def ${name}`)) {
      found.push(current);
    }
    for (const child of current.namedChildren) {
      if (child !== null) {
        walk(child);
      }
    }
  };
  walk(node);
  return found[0] as RbNode;
}

/** The database work one method of `source` does, read the way discovery reads a body. */
async function writesIn(method: string, source: string, models = MODELS) {
  const { db, root } = await factsFor({
    "models.rb": models,
    "use.rb": source,
  });
  emitGivesBack(db);
  const body = methodNamed(root, method);
  return storageEffects(
    callsIn(body),
    "use.rb",
    { facts: db, patterns: [ACTIVE_RECORD] },
    body,
  );
}

const accessOf = (effect: unknown) =>
  effect !== undefined &&
  (effect as { type: string }).type === "interaction" &&
  (effect as { interaction: { class: string } }).interaction.class ===
    "storage-access"
    ? (effect as { interaction: Record<string, unknown> }).interaction
    : null;

const containerOf = (effect: unknown) => {
  const semantics =
    (effect as { type: string } | undefined)?.type === "interaction"
      ? (
          effect as {
            binding: { semantics: { name: string; container?: string } };
          }
        ).binding.semantics
      : null;
  return semantics?.name === "storage" ? semantics.container : null;
};

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
    expect(containerOf(effects[0])).toBe("Order");
  });

  it("reads a model written from the top level, `::Order`", async () => {
    const effects = await effectsFor("found = ::Order.find(1)\n");
    expect(effects).toHaveLength(1);
    expect(containerOf(effects[0])).toBe("Order");
  });

  it("reads a model written by its compound path, `Shop::Order`", async () => {
    const effects = await effectsFor(
      "found = Shop::Order.find(1)\n",
      [
        "class ApplicationRecord < ActiveRecord::Base",
        "end",
        "module Shop",
        "  class Order < ApplicationRecord",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    expect(effects).toHaveLength(1);
    expect(containerOf(effects[0])).toBe("Shop::Order");
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
      storageEffects(callsIn(tree.rootNode), "use.rb", {
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

  it("reads a model whose class a second file opens again", async () => {
    const { db, root } = await factsFor({
      "one.rb": "class Order < ApplicationRecord\nend\n",
      "two.rb": "class Order\nend\n",
      "models.rb": MODELS,
      "use.rb": "found = Order.where(id: 1).first\n",
    });

    expect(
      storageEffects(callsIn(root), "use.rb", {
        facts: db,
        patterns: [ACTIVE_RECORD],
      }),
    ).toMatchObject([
      { binding: { semantics: { container: "Order" } }, type: "interaction" },
    ]);
  });

  describe("read through a loader", () => {
    it("records the model a picked source is given", async () => {
      const effects = await effectsFor(
        "dataloader.with(Sources::Record, ::Order).load(id)\n",
      );
      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Order");
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "load",
      });
    });

    it("records the model a shortcut is given", async () => {
      const effects = await effectsFor("dataload_record(Order, object.id)\n");
      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Order");
      expect(accessOf(effects[0])).toMatchObject({
        operation: "dataload_record",
      });
    });

    it("says nothing about a source given no model", async () => {
      const effects = await effectsFor(
        "dataloader.with(Sources::Record, :users).load(id)\n",
      );
      expect(effects).toEqual([]);
    });

    it("says nothing about a read on something other than the loader", async () => {
      const effects = await effectsFor("cache.with(Order).load(id)\n");
      expect(effects).toEqual([]);
    });

    it("claims the loader call so a walk does not report it as a gap", async () => {
      const { db, root } = await factsFor({
        "models.rb": MODELS,
        "use.rb":
          "dataloader.with(Sources::Record, ::Order).load(id)\nother.load(id)\n",
      });
      const options = {
        facts: db,
        patterns: [ACTIVE_RECORD],
        loaders: [DATALOADER],
      };
      const [loaded, other] = callsIn(root).filter((call) =>
        call.text.endsWith(".load(id)"),
      );
      expect(storageClaims(loaded as RbNode, "use.rb", options)).toBe(true);
      expect(storageClaims(other as RbNode, "use.rb", options)).toBe(false);
    });
  });

  describe("a write on a receiver the rules settle on a model", () => {
    it("records the write a controller makes on an instance variable a filter set", async () => {
      const effects = await writesIn("suspend", CONTROLLER);

      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Order");
      expect(accessOf(effects[0])).toMatchObject({
        kind: "write",
        operation: "update!",
      });
    });

    it("records the write on a local written from a finder", async () => {
      const effects = await writesIn(
        "archive",
        [
          "class OrdersController",
          "  def archive",
          "    order = Order.find(params[:id])",
          "    order.save",
          "  end",
          "end",
          "",
        ].join("\n"),
      );

      expect(effects).toHaveLength(2);
      expect(containerOf(effects[1])).toBe("Order");
      expect(accessOf(effects[1])).toMatchObject({
        kind: "write",
        operation: "save",
      });
    });

    it("says nothing about a keyword the write was given, since the record is already in hand", async () => {
      const effects = await writesIn("suspend", CONTROLLER);
      expect(accessOf(effects[0])).not.toHaveProperty("selector");
    });

    it("says nothing about a read on the same receiver", async () => {
      const effects = await writesIn(
        "show",
        [
          "class OrdersController",
          "  def set_order",
          "    @order = Order.find(params[:id])",
          "  end",
          "",
          "  def show",
          "    render json: @order.total",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      expect(effects).toEqual([]);
    });

    it("says nothing when the project writes the method itself", async () => {
      const effects = await writesIn(
        "suspend",
        CONTROLLER,
        [
          "class ApplicationRecord < ActiveRecord::Base",
          "end",
          "",
          "class Order < ApplicationRecord",
          "  def update!(attrs)",
          "    super",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      expect(effects).toEqual([]);
    });

    it("says nothing when the rules settle the receiver on nothing", async () => {
      const effects = await writesIn(
        "suspend",
        [
          "class OrdersController",
          "  def suspend",
          "    @order.update!(suspended_at: Time.now)",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      expect(effects).toEqual([]);
    });

    it("claims the write so a walk does not report it as a gap", async () => {
      const { db, root } = await factsFor({
        "models.rb": MODELS,
        "use.rb": CONTROLLER,
      });
      emitGivesBack(db);
      const method = methodNamed(root, "suspend");
      const [write] = callsIn(method).filter((call) =>
        call.text.startsWith("@order.update!"),
      );

      expect(
        storageClaims(
          write as RbNode,
          "use.rb",
          { facts: db, patterns: [ACTIVE_RECORD] },
          method,
        ),
      ).toBe(true);
    });
  });
});
