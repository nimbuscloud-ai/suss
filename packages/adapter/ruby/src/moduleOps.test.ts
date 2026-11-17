import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverDeclared } from "@suss/recognize";

import { graphqlFields } from "./__fixtures__/graphqlRubyPattern.js";
import { preloadRubyGrammar } from "./parser.js";
import { moduleOpsForFile } from "./project.js";

let dir: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-module-ops-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function opsOf(source: string) {
  const file = path.join(dir, "engine.rb");
  fs.writeFileSync(file, source);
  return moduleOpsForFile(file);
}

describe("one Ruby file read on its own as module ops", () => {
  it("reads a list through a name with its spreads in place, and no list a method returns", () => {
    const module = opsOf(
      "more = [b]\n" +
        "routes = [a, *more, make()]\n" +
        "router(routes)\n" +
        "again(routes)\n" +
        "router(built())\n",
    );
    const [first, second, third] = module
      .calls()
      .filter((call) => ["router", "again"].includes(call.calleeText()))
      .map((call) => call.valueAt(0)?.listed?.() ?? null);

    expect(
      first?.entries.map(({ form, value }) => `${form} ${value.source?.()}`),
    ).toEqual(["value a", "spread more", "value make()"]);
    expect(second?.key).toBe(first?.key);
    expect(third).toBeNull();
    expect(module.importedNames(["rails"]).size).toBe(0);
  });

  it("lists every class and module the file writes, by its full name, and whether it extends a library base", () => {
    const module = opsOf(
      "module Billing\n" +
        "  class Engine < ::Rails::Engine\n" +
        "    isolate_namespace Billing\n" +
        "  end\n" +
        "end\n" +
        "class Other < Rails::Engine\nend\n",
    );
    const engine = [{ from: ["Rails"], named: ["Engine"] }];
    expect(
      module.classes().map((cls) => [cls.name(), cls.inherits(engine)]),
    ).toEqual([
      ["Billing", false],
      ["Billing::Engine", true],
      ["Other", true],
    ]);
  });

  it("reaches a base through any body written for the class, and a project base by its full name, though no class is its own base", () => {
    const module = opsOf(
      "class Types::BaseObject < GraphQL::Schema::Object\n" +
        "end\n" +
        "class Types::Reopened < Types::BaseObject\n" +
        "end\n" +
        "class Types::Reopened\n" +
        "end\n" +
        "module Types\n" +
        "  class Query < BaseObject\n" +
        "  end\n" +
        "  module Node\n" +
        "    include BaseObject\n" +
        "  end\n" +
        "end\n" +
        "class Types::BaseObject\n" +
        "end\n",
    );
    const project = [{ from: ["Types"], named: ["BaseObject"] }];
    const library = [{ from: ["GraphQL::Schema"], named: ["Object"] }];
    expect(
      module
        .classes()
        .map((cls) =>
          [cls.name(), cls.inherits(project), cls.inherits(library)].join(" "),
        ),
    ).toEqual([
      "Types::BaseObject false true",
      "Types::Reopened true true",
      "Types::Reopened true true",
      "Types false false",
      "Types::Query true true",
      "Types::Node true true",
      "Types::BaseObject false true",
    ]);
  });

  it("declares a unit for each naming call in a class body, named and run the way the match says", () => {
    const module = opsOf(
      "class Types::BaseObject < GraphQL::Schema::Object\n" +
        "  field :base_only, String\n" +
        "end\n" +
        "module Mutations\n" +
        "  class Approve\n" +
        "    def resolve(id:)\n" +
        "      id\n" +
        "    end\n" +
        "  end\n" +
        "end\n" +
        "module Types\n" +
        "  class TalkType < BaseObject\n" +
        '    graphql_name "Session"\n' +
        "    field :user_name, String, null: false\n" +
        "    field :raw_name, String, camelize: false\n" +
        "    field :title, String, resolver_method: :custom_title\n" +
        "    field :approve, mutation: Mutations::Approve\n" +
        "    field :remote, resolver: Remote::Missing\n" +
        "    field :user_name, Integer\n" +
        "    self.field :not_on_self, String\n" +
        "    %i[value].each do |name|\n" +
        "      field name, String\n" +
        "    end\n" +
        "\n" +
        "    def user_name\n" +
        '      "x"\n' +
        "    end\n" +
        "\n" +
        "    def custom_title\n" +
        '      "t"\n' +
        "    end\n" +
        "  end\n" +
        "end\n" +
        "class Types::PlainType < Types::BaseObject\n" +
        "  field :value, String\n" +
        "end\n",
    );
    const units = discoverDeclared(graphqlFields(), "resolver", module);
    expect(
      units.map((unit) => {
        const runs = unit.namedBy?.runs ?? null;
        return [
          unit.name,
          runs === null ? "-" : (runs.keyword ?? "own"),
          runs?.methodName ?? "-",
          unit.func === null ? "absent" : "method",
        ].join(" ");
      }),
    ).toEqual([
      "Plain.value own value absent",
      "Session.userName own user_name method",
      "Session.raw_name own raw_name absent",
      "Session.title resolver_method custom_title method",
      "Session.approve mutation resolve method",
      "Session.remote resolver resolve absent",
      "Session.name - - absent",
    ]);
    const redeclared = units.find((unit) => unit.name === "Session.userName");
    expect(redeclared?.namedBy?.call.valueAt(1)?.source?.()).toBe("Integer");
    const computed = units.find((unit) => unit.name === "Session.name");
    expect(computed?.namedBy?.settled).toBe(false);
  });

  it("evaluates a value with a block's variables bound, and a name with nothing written to it as nothing", () => {
    const module = opsOf(
      '%w[users].each do |root|\n  get "#{root}/x", to: target\nend\n',
    );
    const [loop] = module.bodyCalls();
    const [get] = loop?.block?.()?.bodyCalls?.() ?? [];
    const bindings = new Map([["root", "users"]]);
    expect(get?.valueAt(0)?.evaluatedWith?.(bindings)).toBe("users/x");
    expect(get?.keywordAt?.("to")?.evaluatedWith?.(bindings)).toBeNull();
  });

  it("gives a list written as %w[] or %i[] the shape of an array, as it gives [...]", () => {
    const [call] = opsOf("only %w[a], %i[b], [:c], list\n").bodyCalls();
    const shapes = [0, 1, 2, 3].map((at) => call?.valueAt(at)?.shape?.()?.type);
    expect(shapes).toEqual(["array", "array", "array", "unknown"]);
  });

  it("gives an argument written as a constant its path as written, and a name none", () => {
    const [first, second, third] = opsOf(
      "describe Billing::Order do\nend\ndescribe GREETING do\nend\n" +
        "[1].each do |order|\n  describe order do\n  end\nend\n",
    )
      .calls("file")
      .filter((call) => call.calleeText() === "describe");
    expect(first?.valueAt(0)?.constantPath?.()).toBe("Billing::Order");
    expect(second?.valueAt(0)?.constantPath?.()).toBe("GREETING");
    expect(third?.valueAt(0)?.constantPath?.()).toBeNull();
  });

  it("lists every call a block writes, those in blocks inside it too, in source order", () => {
    const [group] = opsOf(
      "describe 'orders' do\n  it 'cancels' do\n    [1].each { |x| cancel(x) }\n  end\nend\n",
    ).bodyCalls();
    expect(
      group
        ?.block?.()
        ?.calls?.()
        .map((call) => call.calleeText()),
    ).toEqual(["it", "[1].each", "cancel"]);
  });
});
