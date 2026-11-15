// What the reader finds in a class body, over facts written out by hand,
// so what is under test is the reader and the class ops, not any one
// language's facts.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  association,
  callback,
  classBody,
  declareClassBodies,
  declareClassBody,
  definesMethod,
  describeClassBody,
} from "./classBody.js";
import { type FactSource, factModuleOps, factValueOps } from "./factOps.js";
import { imported, inherits } from "./ops.js";

import type { ClassValueOps } from "@suss/extractor";
import type { ClassDeclaration } from "./classBody.js";

/**
 * `class Account < Model` with `has_many :items`, `has_many :owners,
 * class_name: "Person"`, `has_many :parts, class_name: Part`, three
 * `after_commit` calls (`on: :create`, `on: %i(create update)`, none),
 * `scope :recent, -> {}`, `scope :stale, stale_query`, `self.has_many
 * :others` and `items2 = links("Item")`; `class Other < Thing`; and a
 * module `Mixin` that writes no base.
 */
function source(over: Partial<FactSource> = {}): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const call = (key: string, callee: string, ...args: string[]) => {
    add("call", key, `${callee}#callee`);
    args.forEach((arg, at) => add("callArg", key, String(at), arg));
  };
  add("objectValue", "Account");
  add("extendsNamed", "Account", "Model");
  add("extends", "Account", "Model#ref");
  add("rbConstantName", "Account", "Account");
  call("c1", "has_many", "items");
  call("c2", "has_many", "owners");
  add("callKeywordArg", "c2", "class_name", "person");
  call("c3", "has_many", "parts");
  add("callKeywordArg", "c3", "class_name", "Part#ref");
  call("c4", "after_commit", "sync");
  add("callKeywordArg", "c4", "on", "create");
  call("c5", "after_commit", "index");
  add("callKeywordArg", "c5", "on", "events");
  add("objectValue", "events");
  add("writtenEntryAt", "events", "0", "create2", "value");
  add("writtenEntryAt", "events", "1", "update", "value");
  call("c6", "after_commit", "audit");
  call("c7", "scope", "recent", "lambda");
  call("c8", "scope", "stale", "staleQuery");
  add("call", "c9", "c9#callee");
  add("readsProperty", "c9#callee", "self", "has_many");
  call("c10", "has_many", "UNSETTLED");
  call("f1", "links", "item");
  add("holdsProperty", "Account", "items2", "f1");
  call("f2", "build", "item");
  add("holdsProperty", "Account", "built", "f2");
  add("holdsProperty", "Account", "LIMIT", "ten");
  add("objectValue", "Other");
  add("extendsNamed", "Other", "Thing");
  add("extends", "Other", "Thing#ref");
  add("rbConstantName", "Other", "Other");
  call("o1", "has_many", "items");
  add("objectValue", "Patched");
  add("extendsNamed", "Patched", "lib::Model");
  add("objectValue", "Mixin");
  add("rbConstantName", "Mixin", "Mixin");
  call("m1", "has_many", "items");
  add("bodyCallAt", "Account", "0", "c1");

  const bodies: Record<string, string[]> = {
    Account: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"],
    Other: ["o1"],
    Mixin: ["m1"],
  };
  const names: Record<string, string> = {
    items: "items",
    owners: "owners",
    parts: "parts",
    sync: "sync",
    index: "index",
    audit: "audit",
    recent: "recent",
    stale: "stale",
    create2: "create",
    update: "update",
    person: "Person",
    item: "Item",
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) => {
      if (key === "links#callee" && module === "lib") {
        return ["links"];
      }
      return key === "Model#ref" && module === "lib" ? ["Model"] : [];
    },
    shapeOf: (key) => (key === "events" ? "list" : null),
    textOf: (key) =>
      key === "c9#callee" ? "self.has_many" : key.replace("#callee", ""),
    literalOf: (key) =>
      key === "person" || key === "item" ? (names[key] ?? null) : null,
    nameOf: (key) => names[key] ?? null,
    evaluatedOf: (key) => (key === "create" ? "create" : null),
    formOf: (key) => (key === "lambda" ? "function" : "other"),
    argOf: () => null,
    classBodyCalls: (key) => bodies[key] ?? [],
    ...over,
  };
}

const LIBRARY = classBody({
  calls: {
    has_many: association({
      name: { at: 0 },
      target: { keyword: "class_name" },
      plural: true,
    }),
    after_commit: callback({
      methods: { from: 0 },
      events: ["create", "update", "destroy"],
      narrowedBy: { keyword: "on" },
    }),
    scope: definesMethod({ name: { at: 0 }, body: { at: 1 } }),
  },
  fields: {
    association: { madeBy: imported({ from: ["lib"], named: ["links"] }) },
  },
});

function classOf(key: string, facts: FactSource = source()): ClassValueOps {
  const cls = factValueOps(key, facts).asClass?.() ?? null;
  if (cls === null) {
    throw new Error(`no class at ${key}`);
  }
  return cls;
}

/** What each declaration says, without the class it was read off. */
function said(declarations: readonly ClassDeclaration[]) {
  return declarations.map((declared) => {
    if (declared.kind === "method") {
      return { kind: "method", name: declared.name };
    }
    const { cls: _cls, ...rest } = declared;
    return rest;
  });
}

const ITEMS = {
  kind: "association",
  name: "items",
  target: { inflect: "items", plural: true },
};

describe("the reader of a class body", () => {
  it("reads each call the declaration lists, in source order, and the fields after them", () => {
    expect(said(declareClassBody(LIBRARY, classOf("Account")))).toEqual([
      ITEMS,
      { kind: "association", name: "owners", target: { written: "Person" } },
      { kind: "association", name: "parts", target: null },
      { kind: "callback", events: ["create"], methods: ["sync"] },
      { kind: "callback", events: ["create", "update"], methods: ["index"] },
      {
        kind: "callback",
        events: ["create", "update", "destroy"],
        methods: ["audit"],
      },
      { kind: "method", name: "recent" },
      { kind: "association", name: "items2", target: { written: "Item" } },
    ]);
  });

  it("reads no field for a declaration that lists none", () => {
    const scopes = classBody({
      calls: { scope: definesMethod({ name: { at: 0 }, body: { at: 1 } }) },
    });
    expect(said(declareClassBody(scopes, classOf("Account")))).toEqual([
      { kind: "method", name: "recent" },
    ]);
  });

  it("reads every class a file writes", () => {
    const module = factModuleOps("app.rb", source(), {
      calls: () => [],
      classes: () => ["Account", "Mixin"],
    });
    expect(
      declareClassBodies(LIBRARY, module).map((one) => one.cls.name()),
    ).toContain("Mixin");
  });

  it("reads a class that reaches the base, and a body that writes none, when the declaration names one", () => {
    const gated = classBody({
      ...LIBRARY,
      in: inherits({ from: ["lib"], named: ["Model"] }),
    });
    const facts = source();
    expect(declareClassBody(gated, classOf("Account", facts))).not.toEqual([]);
    expect(declareClassBody(gated, classOf("Other", facts))).toEqual([]);
    expect(said(declareClassBody(gated, classOf("Mixin", facts)))).toEqual([
      ITEMS,
    ]);
  });

  it("counts one data link for each call and field a declaration reads", () => {
    expect(describeClassBody(LIBRARY)).toEqual({
      name: "classBody",
      dataLinks: 4,
      functionLinks: [],
      astLinks: [],
      example: null,
    });
    expect(classBody({}).calls).toEqual({});
  });
});

describe("the class ops a class body is read through", () => {
  it("reach a base by the name the class writes, where the adapter says it spells the spec", () => {
    const spec = inherits({ from: ["lib"], named: ["Model"] });
    expect(classOf("Patched").inherits(spec)).toBe(false);
    const spelled = source({
      spellsBase: (written, asked) =>
        asked.from.some((module) => written === `${module}::Model`),
    });
    expect(classOf("Patched", spelled).inherits(spec)).toBe(true);
  });

  it("say whether the declaration writes a base class", () => {
    const facts = source();
    expect(classOf("Account", facts).writesBase()).toBe(true);
    expect(classOf("Mixin", facts).writesBase()).toBe(false);
  });

  it("list the calls assigned to the class's own names", () => {
    expect(
      classOf("Account")
        .fieldCalls()
        .map(({ name, call }) => [name, call.calleeText()]),
    ).toEqual([
      ["items2", "links"],
      ["built", "build"],
    ]);
  });

  it("read the body's own statements where the adapter asks no rule", () => {
    const { classBodyCalls: _asked, ...facts } = source();
    expect(
      classOf("Account", facts)
        .bodyCalls()
        .map((call) => call.calleeText()),
    ).toEqual(["has_many"]);
  });
});
