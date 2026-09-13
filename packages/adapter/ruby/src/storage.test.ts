import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { storageClaims, storageEffects } from "./storage.js";

import type {
  RbAssociationCalls,
  RbLoaderPattern,
  RbStoragePattern,
} from "./pack.js";
import type { RbNode } from "./parser.js";

const ACTIVE_RECORD: RbStoragePattern = {
  baseClasses: ["ActiveRecord::Base"],
  writes: [
    "update",
    "update!",
    "update_all",
    "destroy",
    "save",
    "create",
    "delete_all",
  ],
  reads: [
    "find",
    "find_by",
    "where",
    "order",
    "limit",
    "first",
    "count",
    "pluck",
    "select",
  ],
  givesBack: ["find", "where", "first"],
  byPrimaryKey: {
    methods: ["find", "update", "destroy"],
    column: "id",
  },
  columnArguments: ["pluck", "select"],
  associations: {
    singular: ["has_one", "belongs_to"],
    plural: ["has_many"],
    classNameKeyword: "class_name",
  },
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
    constants.push(
      collectFileConstants(file, tree.rootNode, [
        ACTIVE_RECORD.associations as RbAssociationCalls,
      ]),
    );
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

/** Two models, one of which declares that it reaches the other. */
const ASSOCIATED_MODELS = [
  "class ApplicationRecord < ActiveRecord::Base",
  "end",
  "",
  "class Status < ApplicationRecord",
  "end",
  "",
  "class Account < ApplicationRecord",
  "  has_many :statuses",
  "end",
  "",
].join("\n");

/** A filter sets the account, and each action reads or writes through it. */
const ACCOUNTS_CONTROLLER = [
  "class AccountsController",
  "  before_action :set_account",
  "",
  "  def set_account",
  "    @account = Account.find(params[:id])",
  "  end",
  "",
  "  def show",
  "    @account.statuses.find(params[:status_id])",
  "  end",
  "",
  "  def rename",
  "    @account.update(name: params[:name])",
  "  end",
  "",
  "  def title",
  "    @account.name",
  "  end",
  "end",
  "",
].join("\n");

/** A model with a class method and an instance method of the project's own. */
const PROJECT_METHODS = [
  "class ApplicationRecord < ActiveRecord::Base",
  "end",
  "",
  "class Order < ApplicationRecord",
  "  def self.recent_for(account)",
  "    where(account: account)",
  "  end",
  "",
  "  def summary",
  "    name",
  "  end",
  "end",
  "",
].join("\n");

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

/** The pack word that says a finder gives back one of the model, which a run adds through `addPackWords`. */
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

  it("picks rows by the primary key when the finder was given one", async () => {
    const effects = await effectsFor("found = Order.find(params[:id])\n");
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      operation: "find",
      selector: ["id"],
      fields: [],
    });
  });

  it("picks rows by the keywords a finder was given", async () => {
    const effects = await effectsFor("found = Order.find_by(email: email)\n");
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      selector: ["email"],
    });
  });

  it("picks rows by the keywords written inside braces", async () => {
    const effects = await effectsFor("found = Order.find_by({ email: x })\n");
    expect(accessOf(effects[0])).toMatchObject({ selector: ["email"] });
  });

  it("reads a chain by what every read along it picked", async () => {
    const effects = await effectsFor(
      "found = Order.where(a: 1).order(:b).first\n",
    );

    expect(effects).toHaveLength(1);
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      operation: "first",
      selector: ["a"],
      fields: [],
    });
  });

  it("says which columns a write was given", async () => {
    const effects = await effectsFor(
      "Order.create(name: name, email: email)\n",
    );
    expect(accessOf(effects[0])).toMatchObject({
      kind: "write",
      operation: "create",
      fields: ["name", "email"],
    });
  });

  it("says both what a write picked and what it set", async () => {
    const effects = await effectsFor(
      "Order.where(id: id).update_all(state: 1)\n",
    );
    expect(accessOf(effects[0])).toMatchObject({
      kind: "write",
      operation: "update_all",
      selector: ["id"],
      fields: ["state"],
    });
  });

  it("says which columns a read asked for by name", async () => {
    const effects = await effectsFor("names = Order.pluck(:name)\n");
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      operation: "pluck",
      fields: ["name"],
    });
  });

  it("says which columns a read asked for through a constant", async () => {
    const effects = await effectsFor(
      ["COLUMN = :name", "names = Order.pluck(COLUMN)"].join("\n"),
    );
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      operation: "pluck",
      fields: ["name"],
    });
  });

  it("picks rows by the keywords a hash held in a constant writes", async () => {
    const effects = await effectsFor(
      ["CONDITIONS = { email: nil }", "found = Order.find_by(CONDITIONS)"].join(
        "\n",
      ),
    );
    expect(accessOf(effects[0])).toMatchObject({
      kind: "read",
      selector: ["email"],
    });
  });

  it("says nothing about the columns a write was given as a variable", async () => {
    const effects = await effectsFor("Order.create(attrs)\n");
    expect(accessOf(effects[0])).toMatchObject({ kind: "write", fields: [] });
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

  describe("a method the library does not define", () => {
    it("says nothing about a constructor, which asks the database for nothing", async () => {
      expect(await effectsFor("order = Order.new(name: name)\n")).toEqual([]);
    });

    it("says nothing about a transaction, which runs no query of its own", async () => {
      expect(await effectsFor("Order.transaction do\n  x = 1\nend\n")).toEqual(
        [],
      );
    });

    it("says nothing about a class method the project writes itself", async () => {
      expect(
        await effectsFor(
          "found = Order.recent_for(account)\n",
          PROJECT_METHODS,
        ),
      ).toEqual([]);
    });

    it("leaves that method to the walk rather than claiming it", async () => {
      const { db, root } = await factsFor({
        "models.rb": PROJECT_METHODS,
        "use.rb": "found = Order.recent_for(account)\n",
      });
      const [call] = callsIn(root).filter((candidate) =>
        candidate.text.startsWith("Order.recent_for"),
      );

      expect(
        storageClaims(call as RbNode, "use.rb", {
          facts: db,
          patterns: [ACTIVE_RECORD],
        }),
      ).toBe(false);
    });

    it("records the read a chain did before a project method the walk follows", async () => {
      const effects = await effectsFor(
        "found = Order.where(id: id).recent_for(account)\n",
      );

      expect(effects).toHaveLength(1);
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "where",
        selector: ["id"],
      });
    });
  });

  describe("a chain that goes on past the call the library defines", () => {
    it("records the finder a safely navigated project method follows", async () => {
      const effects = await effectsFor(
        "quoted = Order.find(params[:id])&.summary\n",
        PROJECT_METHODS,
      );

      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Order");
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "find",
        selector: ["id"],
      });
    });

    it("records the read an attribute read follows", async () => {
      const effects = await effectsFor("name = Order.where(a: 1).first.name\n");

      expect(effects).toHaveLength(1);
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "first",
        selector: ["a"],
      });
    });

    it("records the read a predicate on the result follows", async () => {
      const effects = await effectsFor(
        "there = Order.find_by(email: email).present?\n",
      );

      expect(effects).toHaveLength(1);
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "find_by",
        selector: ["email"],
      });
    });
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

  describe("a call on a receiver the rules settle on a model", () => {
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

    it("counts a keyword the write was given as a column it set, not as one it picked by", async () => {
      const effects = await writesIn("suspend", CONTROLLER);

      expect(accessOf(effects[0])).not.toHaveProperty("selector");
      expect(accessOf(effects[0])).toMatchObject({
        fields: ["suspended_at"],
      });
    });

    it("records the write an action makes with the columns it set", async () => {
      const effects = await writesIn(
        "rename",
        ACCOUNTS_CONTROLLER,
        ASSOCIATED_MODELS,
      );

      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Account");
      expect(accessOf(effects[0])).toMatchObject({
        kind: "write",
        operation: "update",
        fields: ["name"],
      });
    });

    it("records a read through an association against the model it reaches", async () => {
      const effects = await writesIn(
        "show",
        ACCOUNTS_CONTROLLER,
        ASSOCIATED_MODELS,
      );

      expect(effects).toHaveLength(1);
      expect(containerOf(effects[0])).toBe("Status");
      expect(accessOf(effects[0])).toMatchObject({
        kind: "read",
        operation: "find",
        selector: ["id"],
      });
    });

    it("says nothing about a method the library does not define, attribute or not", async () => {
      const effects = await writesIn(
        "title",
        ACCOUNTS_CONTROLLER,
        ASSOCIATED_MODELS,
      );
      expect(effects).toEqual([]);
    });

    it("says nothing when the rules settle the receiver on two classes", async () => {
      const effects = await writesIn(
        "suspend",
        [
          "class ThingsController",
          "  def set_thing",
          "    @thing = Account.find(params[:id])",
          "    @thing = Status.find(params[:id])",
          "  end",
          "",
          "  def suspend",
          "    @thing.save",
          "  end",
          "end",
          "",
        ].join("\n"),
        ASSOCIATED_MODELS,
      );
      expect(effects).toEqual([]);
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
