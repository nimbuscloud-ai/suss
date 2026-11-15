// What a model's class body declares, read through a pack's class-body
// declaration and stated as the facts the rules read.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import {
  association,
  callback,
  classBody,
  definesMethod,
  inherits,
} from "@suss/recognize";
import { classMemberName } from "@suss/resolution";

import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { RunFacts } from "./project.js";

import type { RbBodyBlock, RbInflections, RubyPack } from "./pack.js";

const CLASS_NAME = { keyword: "class_name" };

/** ActiveRecord's own four association calls, `after_commit`, and `scope`, as the pack declares them. */
const ACTIVE_RECORD = classBody({
  calls: {
    has_one: association({ name: { at: 0 }, target: CLASS_NAME }),
    belongs_to: association({ name: { at: 0 }, target: CLASS_NAME }),
    has_many: association({
      name: { at: 0 },
      target: CLASS_NAME,
      plural: true,
    }),
    has_and_belongs_to_many: association({
      name: { at: 0 },
      target: CLASS_NAME,
      plural: true,
    }),
    after_commit: callback({
      methods: { from: 0 },
      events: ["create", "update", "destroy"],
      narrowedBy: { keyword: "on" },
    }),
    scope: definesMethod({ name: { at: 0 }, body: { at: 1 } }),
  },
});

/** The blocks Rails runs as part of the body around them. */
const RAILS_BODY_BLOCKS: RbBodyBlock[] = [
  { name: "included", moduleOnly: true },
  { name: "concerning", moduleBody: true },
  { name: "with_options" },
];

async function factsFor(
  files: Record<string, string>,
  inflections?: RbInflections,
  bodyBlocks: RbBodyBlock[] = [],
  declaration = ACTIVE_RECORD,
): Promise<Database> {
  const pack: RubyPack = {
    name: "models",
    protocol: "postgresql",
    discovery: [],
    classBodies: [declaration],
    bodyBlocks,
    ...(inflections === undefined ? {} : { inflections }),
  };
  const facts = new RunFacts(new Database(), [pack]);
  for (const [file, source] of Object.entries(files)) {
    facts.addFile(file, (await parseRuby(source)).rootNode);
  }
  facts.finish();
  return facts.db;
}

/** Every association a run declares, as `name -> the qualified name its target binds to`. */
function targetsOf(db: Database): Record<string, string> {
  const named = new Map(
    db.facts("rbConstantName").map((row) => [String(row[0]), String(row[1])]),
  );
  const bound = new Map(
    db.facts("binds").map((row) => [String(row[0]), String(row[1])]),
  );
  const targets: Record<string, string> = {};
  for (const row of db.facts("declaresAssociation")) {
    const definition = bound.get(String(row[2]));
    targets[String(row[1])] =
      definition === undefined ? "" : (named.get(definition) ?? "");
  }
  return targets;
}

describe("an association ActiveRecord declares", () => {
  it("is read from each of the four calls", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "class Profile; end",
        "class Account; end",
        "class Tag; end",
        "",
        "class User",
        "  has_many :statuses",
        "  has_one :profile",
        "  belongs_to :account",
        "  has_and_belongs_to_many :tags",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({
      statuses: "Status",
      profile: "Profile",
      account: "Account",
      tags: "Tag",
    });
  });

  it("reaches a class only the project's own inflections spell", async () => {
    const models = [
      "class Cow; end",
      "class APIToken; end",
      "",
      "class Account",
      "  has_many :kine",
      "  has_many :api_tokens",
      "end",
      "",
    ].join("\n");

    expect(targetsOf(await factsFor({ "models.rb": models }))).toEqual({
      kine: "",
      api_tokens: "",
    });
    expect(
      targetsOf(
        await factsFor(
          { "models.rb": models },
          { acronyms: ["API"], irregular: [["kine", "cow"]] },
        ),
      ),
    ).toEqual({ kine: "Cow", api_tokens: "APIToken" });
  });

  it("takes the class the declaration writes over the one its name would give", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class User",
        "  has_many :toots, class_name: 'Status'",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ toots: "Status" });
  });

  it("says nothing when the written class is not a plain string", async () => {
    const db = await factsFor({
      "models.rb": [
        "class User",
        '  has_many :toots, class_name: "Status\#{suffix}"',
        "end",
        "",
      ].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("reaches a class under the same namespace before the top-level one", async () => {
    const db = await factsFor({
      "top.rb": "class Status; end\n",
      "admin.rb": [
        "module Admin",
        "  class Status; end",
        "",
        "  class Account",
        "    has_many :statuses",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Admin::Status" });
  });

  it("is not read inside an `included do` block of a concern when no pack says the block runs as part of the body", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "module Account::Associations",
        "  extend ActiveSupport::Concern",
        "",
        "  included do",
        "    has_many :statuses",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({});
  });

  it("is read inside the `included do` block of a concern a class writes in place with `concerning`", async () => {
    const db = await factsFor(
      {
        "models.rb": [
          "class Profile; end",
          "",
          "class Account",
          "  concerning :Profiles do",
          "    included do",
          "      has_one :profile",
          "    end",
          "  end",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      RAILS_BODY_BLOCKS,
    );

    expect(targetsOf(db)).toEqual({ profile: "Profile" });
  });

  it("is not read inside a block that runs after the class body, such as a callback's", async () => {
    const db = await factsFor(
      {
        "models.rb": [
          "class Status; end",
          "",
          "class Account",
          "  after_commit do",
          "    has_many :statuses",
          "  end",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      RAILS_BODY_BLOCKS,
    );

    expect(targetsOf(db)).toEqual({});
  });

  it("is read inside a loop and a class_eval block, which run with the body", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "class Draft; end",
        "",
        "class Account",
        "  %i[statuses].each do |name|",
        "    has_many :statuses",
        "  end",
        "  class_eval do",
        "    has_many :drafts",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status", drafts: "Draft" });
  });

  it("is read inside a block the pack says runs as part of the body", async () => {
    const db = await factsFor(
      {
        "models.rb": [
          "class Status; end",
          "",
          "module Account::Associations",
          "  included do",
          "    with_options dependent: :destroy do",
          "      has_many :statuses",
          "    end",
          "  end",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      RAILS_BODY_BLOCKS,
    );

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("belongs to the class whose body writes it, not a class nested in it", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class Account",
        "  has_many :statuses",
        "",
        "  class Draft",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    const account = db
      .facts("rbConstantName")
      .find((row) => String(row[1]) === "Account");
    expect(
      db.facts("declaresAssociation").map((row) => String(row[0])),
    ).toEqual([String(account?.[0])]);
  });

  it("reads a name written as a string", async () => {
    const db = await factsFor({
      "models.rb": [
        "class Status; end",
        "",
        "class User",
        '  has_many "statuses"',
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("reads a written class pinned to the top level past a nearer one", async () => {
    const db = await factsFor({
      "top.rb": "class Status; end\n",
      "admin.rb": [
        "module Admin",
        "  class Status; end",
        "",
        "  class Account",
        "    has_many :statuses, class_name: '::Status'",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    expect(targetsOf(db)).toEqual({ statuses: "Status" });
  });

  it("says nothing for a call that names no association", async () => {
    const db = await factsFor({
      "models.rb": [
        "class User",
        "  has_many class_name: 'Status'",
        "end",
        "",
      ].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("says nothing when the name is neither a symbol nor a string", async () => {
    const db = await factsFor({
      "models.rb": ["class User", "  has_many STATUSES", "end", ""].join("\n"),
    });

    expect(db.size("declaresAssociation")).toBe(0);
  });

  it("is left out when no pack says what one looks like", async () => {
    const db = new Database();
    const tree = await parseRuby("class Account\n  has_many :statuses\nend\n");
    emitValueFacts(db, "models.rb", tree.rootNode);
    emitConstantBindings(db, [
      collectFileConstants("models.rb", tree.rootNode),
    ]);

    expect(db.size("declaresAssociation")).toBe(0);
  });
});

/** Each `classCallback` row, as `event method`. */
function callbacksOf(db: Database): string[] {
  return db
    .facts("classCallback")
    .map((row) => `${String(row[1])} ${String(row[2])}`);
}

describe("a callback ActiveRecord registers", () => {
  it("runs on every event its call covers, for each method it lists", async () => {
    const db = await factsFor({
      "models.rb": "class Account\n  after_commit :sync, :index\nend\n",
    });

    expect(callbacksOf(db)).toEqual([
      "create sync",
      "create index",
      "update sync",
      "update index",
      "destroy sync",
      "destroy index",
    ]);
  });

  it("runs on the one event `on:` names", async () => {
    const db = await factsFor({
      "models.rb": "class Account\n  after_commit :sync, on: :create\nend\n",
    });

    expect(callbacksOf(db)).toEqual(["create sync"]);
  });

  it("runs on each event an `on:` list names", async () => {
    const db = await factsFor({
      "models.rb":
        "class Account\n  after_commit :sync, on: %i(create update)\nend\n",
    });

    expect(callbacksOf(db)).toEqual(["create sync", "update sync"]);
  });
});

describe("a scope ActiveRecord defines", () => {
  const RECENT = classMemberName("recent");

  /** Each class method a lambda is held under, as `method -> lambda source`. */
  async function scopesOf(source: string): Promise<Record<string, string>> {
    const tree = await parseRuby(source);
    const db = await factsFor({ "models.rb": source });
    const found: Record<string, string> = {};
    for (const row of db.facts("holdsProperty")) {
      const [start, end] = String(row[2]).split(":").at(-1)?.split("-") ?? [];
      const text = tree.rootNode.text.slice(Number(start), Number(end));
      if (text.startsWith("->")) {
        found[String(row[1])] = text;
      }
    }
    return found;
  }

  it("holds the lambda on the class under the class method's name", async () => {
    expect(
      await scopesOf(
        "class Account\n  scope :recent, -> { order(:id) }\nend\n",
      ),
    ).toEqual({ [RECENT]: "-> { order(:id) }" });
  });

  it("is read inside a block no pack declares, as Ruby runs that block with the body", async () => {
    expect(
      await scopesOf(
        "class Account\n  [1].each do\n    scope :recent, -> { order(:id) }\n  end\nend\n",
      ),
    ).toEqual({ [RECENT]: "-> { order(:id) }" });
  });

  it("defines nothing when the second argument is not a lambda", async () => {
    expect(
      await scopesOf("class Account\n  scope :recent, order(:id)\nend\n"),
    ).toEqual({});
  });
});

describe("a declaration read only in the library's own classes", () => {
  const MODELS_ONLY = classBody({
    ...ACTIVE_RECORD,
    in: inherits({ from: ["ActiveRecord"], named: ["Base"] }),
  });

  /** The classes each association is declared in, as `class: name`. */
  function declaredIn(db: Database): string[] {
    const named = new Map(
      db.facts("rbConstantName").map((row) => [String(row[0]), String(row[1])]),
    );
    return db
      .facts("declaresAssociation")
      .map((row) => `${named.get(String(row[0]))}: ${String(row[1])}`);
  }

  it("reads a class two below the base and a module, and leaves out a class beside them", async () => {
    const db = await factsFor(
      {
        "models.rb": [
          "class Status; end",
          "class ApplicationRecord < ActiveRecord::Base; end",
          "",
          "module Account::Associations",
          "  has_many :statuses",
          "end",
          "",
          "class Account < ApplicationRecord",
          "  has_many :statuses",
          "end",
          "",
          "class AccountSerializer < ActiveModel::Serializer",
          "  has_many :statuses",
          "end",
          "",
          "class Account",
          "  belongs_to :status",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      [],
      MODELS_ONLY,
    );

    expect(declaredIn(db)).toEqual([
      "Account::Associations: statuses",
      "Account: statuses",
      "Account: status",
    ]);
  });

  it("reads a model in a project that reopens the library's module", async () => {
    const db = await factsFor(
      {
        "patches.rb": "module ActiveRecord\n  module Batches; end\nend\n",
        "models.rb": [
          "class Status; end",
          "class ApplicationRecord < ActiveRecord::Base; end",
          "class Account < ApplicationRecord",
          "  has_many :statuses",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      [],
      MODELS_ONLY,
    );

    expect(declaredIn(db)).toEqual(["Account: statuses"]);
  });

  it("reads a model in a project that reopens the library's base class itself", async () => {
    const db = await factsFor(
      {
        "patches.rb": "module ActiveRecord\n  class Base\n  end\nend\n",
        "models.rb": [
          "class Status; end",
          "class Account < ActiveRecord::Base",
          "  has_many :statuses",
          "end",
          "",
        ].join("\n"),
      },
      undefined,
      [],
      MODELS_ONLY,
    );

    expect(declaredIn(db)).toEqual(["Account: statuses"]);
  });
});
