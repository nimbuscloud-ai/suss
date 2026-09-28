import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rspecTestPack } from "./__fixtures__/rspecPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RbFactories, RubyPack } from "./pack.js";

let tmpDir: string;

const factoryBotLike: RbFactories = {
  definitionMethods: ["factory"],
  classKeywords: ["class"],
  parentKeywords: ["parent"],
  nestedDefinitionsInherit: true,
  builders: [
    { method: "create" },
    { method: "build" },
    { method: "create", receiver: "FactoryBot" },
  ],
};

const fabricationLike: RbFactories = {
  definitionMethods: ["Fabricator"],
  classKeywords: ["class_name"],
  parentKeywords: ["from"],
  nestedDefinitionsInherit: false,
  builders: [
    { method: "Fabricate" },
    { method: "build", receiver: "Fabricate" },
  ],
};

function factoryPack(factories: RbFactories): RubyPack {
  return {
    name: "factories",
    protocol: "in-process",
    discovery: [],
    factories: [factories],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-factories-"));
  write("app/models/order.rb", [
    "class Order",
    "  def cancel",
    "    audit",
    "  end",
    "",
    "  def audit",
    "    1",
    "  end",
    "end",
    "",
    "module Billing",
    "  class Invoice",
    "    def void",
    "      1",
    "    end",
    "  end",
    "end",
  ]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

async function extract(packs: RubyPack[]): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs,
    workspaceRoot: tmpDir,
    cacheDir: null,
  });
  return summaries;
}

function linkedCalls(
  summaries: readonly BehavioralSummary[],
  name: string,
): string[] {
  const test = summaries.find(
    (one) => one.kind === "test" && one.identity.name === name,
  );
  return (test?.transitions ?? []).flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation" && effect.summary !== undefined
        ? [effect.callee]
        : [],
    ),
  );
}

describe("factory builds in tests", () => {
  it("types a factory_bot build by the class its name, its class: or its parent gives", async () => {
    write("spec/factories/orders.rb", [
      "FactoryBot.define do",
      "  factory :order do",
      "    factory :paid_order do",
      "    end",
      "  end",
      "",
      '  factory :invoice, class: "Billing::Invoice" do',
      "  end",
      "",
      "  factory :late_invoice, parent: :invoice do",
      "  end",
      "end",
    ]);
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "cancels" do',
      "    order = create(:order)",
      "    order.cancel",
      "  end",
      "",
      '  it "cancels a paid one" do',
      "    FactoryBot.create(:paid_order).cancel",
      "  end",
      "",
      '  it "voids" do',
      "    build(:late_invoice).void",
      "  end",
      "end",
    ]);

    const summaries = await extract([
      rspecTestPack(),
      factoryPack(factoryBotLike),
    ]);

    expect(linkedCalls(summaries, "Order > cancels")).toEqual(["order.cancel"]);
    expect(linkedCalls(summaries, "Order > cancels a paid one")).toEqual([
      "FactoryBot.create(:paid_order).cancel",
    ]);
    expect(linkedCalls(summaries, "Order > voids")).toEqual([
      "build(:late_invoice).void",
    ]);
  });

  it("types a Fabrication build through from: and class_name:", async () => {
    write("spec/fabricators/order_fabricator.rb", [
      "Fabricator(:order) do",
      "end",
      "",
      "Fabricator(:refunded_order, from: :order) do",
      "end",
      "",
      'Fabricator(:invoice, class_name: "Billing::Invoice") do',
      "end",
    ]);
    write("spec/order_spec.rb", [
      "describe Order do",
      "  let(:refunded) { Fabricate(:refunded_order) }",
      '  it "cancels" do',
      "    refunded.cancel",
      "  end",
      "",
      '  it "voids" do',
      "    Fabricate.build(:invoice).void",
      "  end",
      "end",
    ]);

    const summaries = await extract([
      rspecTestPack(),
      factoryPack(fabricationLike),
    ]);

    expect(linkedCalls(summaries, "Order > cancels")).toEqual([
      "refunded.cancel",
    ]);
    expect(linkedCalls(summaries, "Order > voids")).toEqual([
      "Fabricate.build(:invoice).void",
    ]);
  });

  it("types a build by a class: constant, and a build of a factory nothing defines by its camelized name", async () => {
    write("spec/factories/orders.rb", [
      "FactoryBot.define do",
      "  factory :bill, class: Billing::Invoice do",
      "  end",
      "",
      "  factory :draft, class: draft_class do",
      "  end",
      "end",
    ]);
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "voids" do',
      "    build(:bill).void",
      "  end",
      "",
      '  it "cancels" do',
      "    create(:order).cancel",
      "  end",
      "",
      '  it "drafts" do',
      "    build(:draft).void",
      "  end",
      "end",
    ]);

    const summaries = await extract([
      rspecTestPack(),
      factoryPack(factoryBotLike),
    ]);

    expect(linkedCalls(summaries, "Order > voids")).toEqual([
      "build(:bill).void",
    ]);
    expect(linkedCalls(summaries, "Order > cancels")).toEqual([
      "create(:order).cancel",
    ]);
    expect(linkedCalls(summaries, "Order > drafts")).toEqual([]);
  });

  it("leaves a build outside a test file alone", async () => {
    write("spec/factories/orders.rb", [
      "FactoryBot.define do",
      "  factory :order do",
      "  end",
      "end",
    ]);
    write("db/seeds.rb", ["def seed", "  create(:order).cancel", "end"]);

    const withPack = await extract([
      rspecTestPack(),
      factoryPack(factoryBotLike),
    ]);
    const without = await extract([rspecTestPack()]);

    expect(withPack).toEqual(without);
  });
});
