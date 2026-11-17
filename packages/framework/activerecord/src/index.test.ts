import { describe, expect, it } from "vitest";

import { factsForFile, parseRuby } from "@suss/adapter-ruby";

import {
  activeRecordClassBodies,
  activeRecordFramework,
  activeRecordRawSql,
  activeRecordStorage,
  withActiveRecord,
} from "./index.js";

import type { RubyPack } from "@suss/adapter-ruby";

const graphqlPack: RubyPack = {
  name: "graphql-ruby",
  protocol: "http-graphql",
  discovery: [],
};

describe("the ActiveRecord pack", () => {
  it("says which base class the library gives a model", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(pattern?.baseClasses).toEqual(["ActiveRecord::Base"]);
    expect(pattern?.writes).toContain("destroy");
    expect(pattern?.writes).toContain("save!");
  });

  it("says which methods give back one of the model", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(pattern?.givesBack).toContain("find");
    expect(pattern?.givesBack).toContain("where");
  });

  it("leaves a method that gives back something else off that list", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(pattern?.givesBack).not.toContain("count");
    expect(pattern?.givesBack).not.toContain("exists?");
  });

  it("takes the database from the caller, since ActiveRecord talks to all of them", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "mysql" });
    expect(pattern?.storageSystem).toBe("mysql");
  });

  it("says which finders take a statement the project wrote, and how it writes a bind value", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(Object.keys(pattern?.statements ?? {})).toEqual([
      "find_by_sql",
      "count_by_sql",
    ]);
    expect(pattern?.bindPlaceholder).toBe("?");
  });

  it("says which event each write runs, and which call registers a callback for it", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(pattern?.callbacks?.eventOf.create).toEqual(["create"]);
    expect(pattern?.callbacks?.eventOf.save).toEqual(["create", "update"]);
    const [body] = activeRecordClassBodies();
    expect(body?.calls.after_commit).toEqual({
      declares: "callback",
      methods: { from: 0 },
      events: ["create", "update", "destroy"],
      narrowedBy: { keyword: "on" },
    });
    expect(body?.calls.before_save).toMatchObject({
      events: ["create", "update"],
    });
  });

  it("reads a body only in a class that reaches ActiveRecord's base", () => {
    const [body] = activeRecordClassBodies();
    expect(body?.in).toEqual([{ from: ["ActiveRecord"], named: ["Base"] }]);
  });

  it("declares the association calls and the scope call a model body writes", () => {
    const [body] = activeRecordClassBodies();
    expect(body?.calls.has_many).toEqual({
      declares: "association",
      name: { at: 0 },
      target: { keyword: "class_name" },
      plural: true,
    });
    expect(body?.calls.belongs_to).toMatchObject({ declares: "association" });
    expect(body?.calls.belongs_to).not.toHaveProperty("plural");
    expect(body?.calls.scope).toEqual({
      declares: "method",
      name: { at: 0 },
      body: { at: 1 },
    });
  });

  it("leaves the bulk writers out, since ActiveRecord runs no callback for them", () => {
    const [pattern] = activeRecordStorage({ storageSystem: "postgresql" });
    expect(pattern?.callbacks?.eventOf.update_all).toBeUndefined();
    expect(pattern?.callbacks?.eventOf.insert_all).toBeUndefined();
    expect(pattern?.callbacks?.eventOf.delete_all).toBeUndefined();
  });

  it("adds itself to a pack without disturbing its discovery", () => {
    const composed = withActiveRecord(graphqlPack, {
      storageSystem: "sqlite",
    });
    expect(composed.name).toBe("graphql-ruby");
    expect(composed.discovery).toBe(graphqlPack.discovery);
    expect(composed.storage).toHaveLength(1);
    expect(composed.rawSql).toHaveLength(1);
    expect(composed.bodyBlocks?.map((block) => block.name)).toEqual([
      "included",
      "with_options",
    ]);
  });

  it("keeps a storage pattern the pack already had", () => {
    const already: RubyPack = {
      ...graphqlPack,
      storage: [
        {
          baseClasses: ["Other::Base"],
          writes: [],
          reads: [],
          givesBack: [],
          storageSystem: "postgresql",
        },
      ],
    };
    expect(
      withActiveRecord(already, { storageSystem: "postgresql" }).storage,
    ).toHaveLength(2);
  });

  it("reads an association inside a concern's `included do` and a `with_options do` in a run without the rails pack", async () => {
    const source = [
      "class Status; end",
      "class Owner; end",
      "",
      "module Account::Associations",
      "  extend ActiveSupport::Concern",
      "",
      "  included do",
      "    has_many :statuses",
      "    with_options dependent: :destroy do",
      "      has_one :owner",
      "    end",
      "  end",
      "end",
      "",
    ].join("\n");
    const db = factsForFile({
      file: "/app/models/account.rb",
      root: (await parseRuby(source)).rootNode,
      packs: [activeRecordFramework({ storageSystem: "postgresql" })],
    });
    expect(
      db.facts("declaresAssociation").map((row) => String(row[1])),
    ).toEqual(["statuses", "owner"]);
  });

  it("stands alone for a run that wants no discovery", () => {
    const pack = activeRecordFramework({ storageSystem: "postgresql" });
    expect(pack.discovery).toEqual([]);
    expect(pack.storage).toHaveLength(1);
    expect(pack.rawSql).toHaveLength(1);
  });
});

describe("the connection ActiveRecord hands out", () => {
  it("matches the base class outright and every subclass through its ancestry", () => {
    const [pattern] = activeRecordRawSql({ storageSystem: "postgresql" });
    expect(pattern?.constantName).toBe("ActiveRecord::Base");
    expect(pattern?.baseClasses).toEqual(["ActiveRecord::Base"]);
    expect(pattern?.clientBuilders).toContain("connection");
    expect(pattern?.clientBuilders).toContain("lease_connection");
  });

  it("lists the calls on it that take a statement", () => {
    const [pattern] = activeRecordRawSql({ storageSystem: "postgresql" });
    expect(pattern?.statements?.execute).toEqual({ at: 0 });
    expect(pattern?.statements?.select_values).toEqual({ at: 0 });
    expect(pattern?.statements?.exec_update).toEqual({ at: 0 });
  });

  it("reads the statements in the dialect of the database the project named", () => {
    const [pattern] = activeRecordRawSql({ storageSystem: "mysql" });
    expect(pattern?.storageSystem).toBe("mysql");
    expect(pattern?.dialect).toBe("mysql");
  });
});

describe("a config that says no database", () => {
  it("refuses with a sentence instead of a TypeError", () => {
    expect(() => activeRecordFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});
