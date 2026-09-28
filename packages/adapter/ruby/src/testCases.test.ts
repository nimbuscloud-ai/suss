import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTestMetadata } from "@suss/behavioral-ir";

import { rspecTestPack } from "./__fixtures__/rspecPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-rspec-"));
  write("app/models/order.rb", [
    "class Order",
    "  def self.cancel(id)",
    "    audit(id)",
    "  end",
    "",
    "  def self.audit(id)",
    "    id",
    "  end",
    "",
    "  def self.refund(id)",
    "    id",
    "  end",
    "",
    "  def self.build(id)",
    "    id",
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

async function extract(
  packs: RubyPack[] = [rspecTestPack()],
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs,
    workspaceRoot: tmpDir,
    cacheDir: null,
  });
  return summaries;
}

function tests(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter((summary) => summary.kind === "test");
}

function testNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = tests(summaries).find((one) => one.identity.name === name);
  if (found === undefined) {
    throw new Error(
      `no test named ${name}: ${tests(summaries)
        .map((one) => one.identity.name)
        .join("; ")}`,
    );
  }
  return found;
}

/** The project calls a unit's summary links to another summary. */
function linkedCalls(summary: BehavioralSummary): string[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation" && effect.summary !== undefined
        ? [effect.callee]
        : [],
    ),
  );
}

function calls(summary: BehavioralSummary): string[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation" ? [effect.callee] : [],
    ),
  );
}

describe("RSpec examples as test units", () => {
  it("names each example by its group titles, a constant by its name as written", async () => {
    write("spec/models/order_spec.rb", [
      "RSpec.describe Order do",
      '  context "when open" do',
      '    it "cancels" do',
      '      Order.cancel("o-1")',
      "    end",
      "  end",
      "end",
      "",
      "describe Orders::Cancel do",
      '  specify "runs" do',
      "  end",
      "end",
    ]);

    const names = tests(await extract()).map((one) => one.identity.name);

    expect(names).toEqual([
      "Order > when open > cancels",
      "Orders::Cancel > runs",
    ]);
  });

  it("gives an example no boundary and records it as a label", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "cancels" do',
      "  end",
      "end",
    ]);

    const [test] = tests(await extract());

    expect(test?.identity.boundaryBinding).toBeNull();
    expect(test?.identity.nameKind).toBe("label");
  });

  it("keeps a title it cannot read as written, and records it as unresolved", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      "  it { is_expected.to be_open }",
      '  it "cancels #{kind}" do',
      "  end",
      "end",
    ]);

    const found = tests(await extract()).map((one) => ({
      name: one.identity.name,
      unresolved: readTestMetadata(one)?.unresolvedTitle,
    }));

    expect(found).toEqual([
      {
        name: "Order > { is_expected.to be_open }",
        unresolved: "{ is_expected.to be_open }",
      },
      {
        name: 'Order > "cancels #{kind}"',
        unresolved: '"cancels #{kind}"',
      },
    ]);
  });

  it("follows an example's calls into the project methods they reach", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "cancels" do',
      '    expect(Order.cancel("o-1")).to eq("o-1")',
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const test = testNamed(summaries, "Order > cancels");

    expect(linkedCalls(test)).toEqual(["Order.cancel"]);
    expect(calls(test)).not.toContain("expect");
    expect(
      summaries
        .filter((one) => one.kind === "library")
        .map((one) => one.identity.name)
        .sort(),
    ).toEqual(["audit", "cancel"]);
  });

  it("reads the hooks and eager values around an example, and the values it reads by name", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      "  before { Order.build(1) }",
      "  let!(:refunded) { Order.refund(1) }",
      "  let(:cancelled) { Order.cancel(id) }",
      '  let(:id) { "o-1" }',
      "  let(:unread) { Order.audit(2) }",
      "",
      '  context "inner" do',
      '    it "reads a value" do',
      "      expect(cancelled).to eq(1)",
      "    end",
      "  end",
      "end",
    ]);

    const test = testNamed(await extract(), "Order > inner > reads a value");

    expect(linkedCalls(test).sort()).toEqual([
      "Order.build",
      "Order.cancel",
      "Order.refund",
    ]);
    expect(calls(test)).not.toContain("cancelled");
  });

  it("reads the subject when the example reads it through is_expected", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      "  subject { Order.cancel(1) }",
      '  it "is cancelled" do',
      "    is_expected.to eq(1)",
      "  end",
      '  it "reads nothing" do',
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(linkedCalls(testNamed(summaries, "Order > is cancelled"))).toEqual([
      "Order.cancel",
    ]);
    expect(linkedCalls(testNamed(summaries, "Order > reads nothing"))).toEqual(
      [],
    );
  });

  it("follows a call on described_class, an implicit subject and a named subject into the described class", async () => {
    write("app/services/checkout.rb", [
      "class Checkout",
      "  def call(id)",
      "    Order.cancel(id)",
      "  end",
      "",
      "  def self.run(id)",
      "    Order.refund(id)",
      "  end",
      "end",
    ]);
    write("spec/checkout_spec.rb", [
      "RSpec.describe Checkout do",
      '  it "runs on the class" do',
      "    described_class.run(1)",
      "  end",
      "",
      '  it "calls the implicit subject" do',
      "    subject.call(1)",
      "  end",
      "",
      '  context "with a subject of its own" do',
      "    subject(:checkout) { described_class.new }",
      "",
      '    it "calls it by name" do',
      "      checkout.call(2)",
      "    end",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const linked = (name: string) =>
      linkedCalls(testNamed(summaries, `Checkout > ${name}`));

    expect(linked("runs on the class")).toEqual(["described_class.run"]);
    expect(linked("calls the implicit subject")).toEqual(["subject.call"]);
    expect(linked("with a subject of its own > calls it by name")).toEqual([
      "checkout.call",
    ]);
  });

  it("follows a predicate matcher to the predicate it calls, on the subject or on what expect is given", async () => {
    write("app/models/account.rb", [
      "class Account",
      "  def local?",
      "    Order.audit(1)",
      "  end",
      "",
      "  def has_notes?",
      "    Order.refund(1)",
      "  end",
      "end",
    ]);
    write("spec/account_spec.rb", [
      "describe Account do",
      "  it { is_expected.to be_local }",
      "",
      '  context "with notes" do',
      "    let(:account) { Account.new }",
      '    it "has them" do',
      "      expect(account).to have_notes",
      "    end",
      "",
      '    it "is not nil" do',
      "      expect(account).not_to be_nil",
      "    end",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(
      linkedCalls(
        testNamed(summaries, "Account > { is_expected.to be_local }"),
      ),
    ).toEqual(["be_local"]);
    expect(
      linkedCalls(testNamed(summaries, "Account > with notes > has them")),
    ).toEqual(["have_notes"]);
    expect(
      linkedCalls(testNamed(summaries, "Account > with notes > is not nil")),
    ).toEqual([]);
  });

  it("records the class a call was sent to, when the method comes from a module the class includes", async () => {
    write("app/models/concerns/reviewable.rb", [
      "module Reviewable",
      "  def reviewed?",
      "    Order.audit(1)",
      "  end",
      "end",
    ]);
    write("app/models/account.rb", [
      "class Account",
      "  include Reviewable",
      "end",
    ]);
    write("spec/account_spec.rb", [
      "describe Account do",
      "  it { is_expected.to be_reviewed }",
      "",
      '  it "reads it" do',
      "    described_class.new.reviewed?",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const sentTo = (name: string) =>
      testNamed(summaries, name).transitions.flatMap((transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "invocation" && effect.summary !== undefined
            ? [[effect.callee, effect.receiverClass]]
            : [],
        ),
      );

    const account = { file: "app/models/account.rb", name: "Account" };
    expect(sentTo("Account > { is_expected.to be_reviewed }")).toEqual([
      ["be_reviewed", account],
    ]);
    expect(sentTo("Account > reads it")).toEqual([
      ["described_class.new.reviewed?", account],
    ]);
  });

  it("keeps an attribute read and a call the project does not define, on the class they were sent to", async () => {
    write("app/models/account.rb", ["class Account", "end"]);
    write("spec/account_spec.rb", [
      "describe Account do",
      '  it "reads a column" do',
      "    expect(described_class.new.username).to eq('a')",
      "  end",
      "",
      '  it "finds one" do',
      "    described_class.find(1)",
      "  end",
      "",
      '  it "reads something else" do',
      "    expect(config.host).to eq('a')",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const sentTo = (name: string) =>
      testNamed(summaries, name).transitions.flatMap((transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "invocation"
            ? [[effect.callee, effect.receiverClass?.name]]
            : [],
        ),
      );

    expect(sentTo("Account > reads a column")).toContainEqual([
      "described_class.new.username",
      "Account",
    ]);
    expect(sentTo("Account > finds one")).toEqual([
      ["described_class.find", "Account"],
    ]);
    expect(sentTo("Account > reads something else")).toEqual([]);
  });

  it("reads a value from the nearest group that defines it, so sibling groups keep their own", async () => {
    write("app/models/account.rb", [
      "class Account",
      "  def lock",
      "    Order.cancel(1)",
      "  end",
      "end",
      "",
      "class Guest",
      "  def lock",
      "    Order.refund(1)",
      "  end",
      "end",
    ]);
    write("spec/account_spec.rb", [
      "describe Account do",
      '  context "a member" do',
      "    let(:who) { Account.new }",
      '    it "locks" do',
      "      who.lock",
      "    end",
      "  end",
      "",
      '  context "a guest" do',
      "    let(:who) { Guest.new }",
      '    it "locks" do',
      "      who.lock",
      "    end",
      "  end",
      "end",
    ]);

    const summaries = await extract();
    const reached = (group: string) =>
      testNamed(summaries, `Account > ${group} > locks`).transitions.flatMap(
        (transition) =>
          transition.effects.flatMap((effect) =>
            effect.type === "invocation" && effect.summary !== undefined
              ? [effect.summary]
              : [],
          ),
      );

    expect(reached("a member")).toHaveLength(1);
    expect(reached("a guest")).toHaveLength(1);
    expect(reached("a member")).not.toEqual(reached("a guest"));
  });

  it("marks an example skipped for each way RSpec spells it", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  xit "x form" do',
      "  end",
      '  it "symbol", :skip do',
      "  end",
      '  it "keyword", skip: "later" do',
      "  end",
      '  it "keyword off", skip: false do',
      "  end",
      '  it "statement" do',
      '    skip "later"',
      "  end",
      '  it "runs" do',
      "  end",
      '  xdescribe "group" do',
      '    it "inside" do',
      "    end",
      "  end",
      '  context "pending before" do',
      '    before { pending "not built" }',
      '    it "inside" do',
      "    end",
      "  end",
      "end",
    ]);

    const skipped = Object.fromEntries(
      tests(await extract()).map((one) => [
        one.identity.name,
        readTestMetadata(one)?.skipped === true,
      ]),
    );

    expect(skipped).toEqual({
      "Order > x form": true,
      "Order > symbol": true,
      "Order > keyword": true,
      "Order > keyword off": false,
      "Order > statement": true,
      "Order > runs": false,
      "Order > group > inside": true,
      "Order > pending before > inside": true,
    });
  });

  it("records a stubbed method as the file that defines its class and the method's name", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      "  before do",
      "    allow(Order).to receive(:cancel).and_return(1)",
      "  end",
      '  it "stubs" do',
      "    allow(Order).to receive_messages(refund: 1, build: 2)",
      "    allow(thing).to receive(:audit)",
      "  end",
      "end",
    ]);

    const [test] = tests(await extract());

    expect(readTestMetadata(test as BehavioralSummary)?.mocks).toEqual([
      {
        module: "app/models/order.rb",
        name: "refund",
        written: "allow(Order).to receive_messages(refund: 1, build: 2)",
      },
      {
        module: "app/models/order.rb",
        name: "build",
        written: "allow(Order).to receive_messages(refund: 1, build: 2)",
      },
      { name: "audit", written: "allow(thing).to receive(:audit)" },
      {
        module: "app/models/order.rb",
        name: "cancel",
        written: "allow(Order).to receive(:cancel).and_return(1)",
      },
    ]);
  });

  it("records a replaced constant as its file, and a double as the call alone unless it becomes the constant", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "replaces" do',
      '    stub_const("Order", double)',
      "    instance_double(Order)",
      "    class_double(Order).as_stubbed_const",
      "  end",
      "end",
    ]);

    const [test] = tests(await extract());

    expect(readTestMetadata(test as BehavioralSummary)?.mocks).toEqual([
      { module: "app/models/order.rb", written: 'stub_const("Order", double)' },
      { written: "instance_double(Order)" },
      { module: "app/models/order.rb", written: "class_double(Order)" },
    ]);
  });

  it("reads no example inside shared examples, and no example outside a group", async () => {
    write("spec/order_spec.rb", [
      'shared_examples "cancellable" do',
      '  it "cancels" do',
      "  end",
      "end",
      'it "alone" do',
      "end",
    ]);

    expect(tests(await extract())).toEqual([]);
  });

  it("reads a shared group's examples under each group that includes it, named the way RSpec prints them", async () => {
    write("spec/support/cancellable.rb", [
      'RSpec.shared_examples "cancellable" do',
      '  it "cancels" do',
      "    target.cancel_now",
      "  end",
      "end",
    ]);
    write("app/models/invoice.rb", [
      "class Invoice",
      "  def cancel_now",
      "    Order.cancel(1)",
      "  end",
      "end",
    ]);
    write("spec/invoice_spec.rb", [
      "describe Invoice do",
      '  it_behaves_like "cancellable" do',
      "    let(:target) { Invoice.new }",
      "  end",
      "",
      '  context "inline" do',
      '    include_examples "cancellable"',
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(tests(summaries).map((one) => one.identity.name)).toEqual([
      "Invoice > behaves like cancellable > cancels",
      "Invoice > inline > cancels",
    ]);
    expect(tests(summaries).map((one) => one.location.file)).toEqual([
      "spec/invoice_spec.rb",
      "spec/invoice_spec.rb",
    ]);
  });

  it("follows a shared example into its one includer's values, and a shared context's values into the includer", async () => {
    write("spec/support/cancellable.rb", [
      'RSpec.shared_examples "cancellable" do',
      '  it "cancels" do',
      "    target.cancel_now",
      "  end",
      "end",
      "",
      'RSpec.shared_context "with an invoice" do',
      "  let(:invoice) { Invoice.new }",
      "  before { Order.build(1) }",
      "end",
    ]);
    write("app/models/invoice.rb", [
      "class Invoice",
      "  def cancel_now",
      "    Order.cancel(1)",
      "  end",
      "end",
    ]);
    write("spec/invoice_spec.rb", [
      "describe Invoice do",
      '  it_behaves_like "cancellable" do',
      "    let(:target) { Invoice.new }",
      "  end",
      "",
      '  context "with a context" do',
      '    include_context "with an invoice"',
      '    it "cancels it" do',
      "      invoice.cancel_now",
      "    end",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(
      linkedCalls(
        testNamed(summaries, "Invoice > behaves like cancellable > cancels"),
      ),
    ).toEqual(["target.cancel_now"]);
    expect(
      linkedCalls(
        testNamed(summaries, "Invoice > with a context > cancels it"),
      ).sort(),
    ).toEqual(["Order.build", "invoice.cancel_now"]);
  });

  it("runs a value once when a hook and the example both read it", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      "  let(:order) { Order.build(1) }",
      "  before { order }",
      '  it "cancels" do',
      "    order",
      "    Order.cancel(1)",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(linkedCalls(testNamed(summaries, "Order > cancels")).sort()).toEqual(
      ["Order.build", "Order.cancel"],
    );
  });

  it("reads no include whose name two files define, and no shared group whose name is not a string", async () => {
    write("spec/support/one.rb", [
      'RSpec.shared_examples "cancellable" do',
      '  it "cancels" do',
      "    Order.cancel(1)",
      "  end",
      "end",
    ]);
    write("spec/support/two.rb", [
      'RSpec.shared_examples "cancellable" do',
      '  it "cancels too" do',
      "    Order.cancel(2)",
      "  end",
      "end",
      "",
      "RSpec.shared_examples SHARED_NAME do",
      '  it "refunds" do',
      "    Order.refund(1)",
      "  end",
      "end",
    ]);
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it_behaves_like "cancellable"',
      "  it_behaves_like SHARED_NAME",
      '  it "builds" do',
      "    Order.build(1)",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(tests(summaries).map((one) => one.identity.name)).toEqual([
      "Order > builds",
    ]);
  });

  it("reads described_class in a shared group as its one includer's class, and leaves it unread when two includers describe two classes", async () => {
    write("spec/support/runnable.rb", [
      'RSpec.shared_examples "runnable" do',
      '  it "runs" do',
      "    described_class.run(1)",
      "  end",
      "end",
      "",
      'RSpec.shared_examples "buildable" do',
      '  it "builds" do',
      "    described_class.build(1)",
      "  end",
      "end",
    ]);
    write("app/services/checkout.rb", [
      "class Checkout",
      "  def self.run(id)",
      "    Order.refund(id)",
      "  end",
      "",
      "  def self.build(id)",
      "    id",
      "  end",
      "end",
    ]);
    write("spec/checkout_spec.rb", [
      "RSpec.describe Checkout do",
      '  it_behaves_like "runnable"',
      '  it_behaves_like "buildable"',
      "end",
    ]);
    write("spec/order_spec.rb", [
      "RSpec.describe Order do",
      '  it_behaves_like "buildable"',
      "end",
    ]);

    const summaries = await extract();

    expect(
      linkedCalls(
        testNamed(summaries, "Checkout > behaves like runnable > runs"),
      ),
    ).toEqual(["described_class.run"]);
    expect(
      linkedCalls(
        testNamed(summaries, "Checkout > behaves like buildable > builds"),
      ),
    ).toEqual([]);
  });

  it("reads only spec files, and only the listed ones when given a list", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "a" do',
      "  end",
      "end",
    ]);
    write("spec/refund_spec.rb", [
      "describe Order do",
      '  it "b" do',
      "  end",
      "end",
    ]);
    write("spec/support/helpers.rb", [
      "describe Order do",
      '  it "c" do',
      "  end",
      "end",
    ]);

    const everySpec = tests(await extract()).map((one) => one.location.file);
    const listed = tests(
      await extract([rspecTestPack(["spec/refund_spec.rb"])]),
    ).map((one) => one.location.file);

    expect(everySpec).toEqual(["spec/order_spec.rb", "spec/refund_spec.rb"]);
    expect(listed).toEqual(["spec/refund_spec.rb"]);
  });

  it("adds nothing to a run without a test pack", async () => {
    write("spec/order_spec.rb", [
      "describe Order do",
      '  it "cancels" do',
      "    Order.cancel(1)",
      "  end",
      "end",
    ]);

    expect(tests(await extract([]))).toEqual([]);
  });
});
