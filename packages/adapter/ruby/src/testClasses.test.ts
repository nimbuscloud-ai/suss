import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTestMetadata } from "@suss/behavioral-ir";

import { extractRubyProject, findRubyFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RbTestClasses, RubyPack } from "./pack.js";

/** What a Minitest pack declares, written out here since the adapter cannot depend on the pack. */
function minitestPack(files?: string[]): RubyPack {
  const pattern: RbTestClasses = {
    filePatterns: ["*_test.rb"],
    baseClassNames: ["Minitest::Test", "ActiveSupport::TestCase"],
    testMethodPrefix: "test_",
    testBlockMethods: ["test"],
    blockTestName: { prefix: "test_", spacesAs: "_" },
    setupBlockMethods: ["setup"],
    setupMethodNames: ["setup"],
    skipStatements: ["skip"],
    assertionPrefixes: ["assert", "refute"],
    stubMethods: ["stub", "stubs", "expects"],
    ...(files === undefined ? {} : { files }),
  };
  return {
    name: "minitest",
    protocol: "in-process",
    discovery: [],
    testClasses: [pattern],
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-minitest-"));
  write("app/models/order.rb", [
    "class Order",
    "  def self.cancel(id)",
    "    id",
    "  end",
    "",
    "  def self.audit(id)",
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
  packs: RubyPack[] = [minitestPack()],
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
  return summaries.filter((one) => one.kind === "test");
}

function testNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = tests(summaries).find((one) => one.identity.name === name);
  if (found === undefined) {
    throw new Error(
      `no test ${name}: ${tests(summaries)
        .map((one) => one.identity.name)
        .join("; ")}`,
    );
  }
  return found;
}

function linkedCalls(summary: BehavioralSummary): string[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation" && effect.summary !== undefined
        ? [effect.callee]
        : [],
    ),
  );
}

describe("Minitest tests as test units", () => {
  it("names a test method and a test block by class and the method the runner gives it", async () => {
    write("test/models/order_test.rb", [
      "class OrderTest < ActiveSupport::TestCase",
      '  test "cancels  twice" do',
      "    Order.cancel(1)",
      "  end",
      "",
      "  def test_audits",
      "    Order.audit(1)",
      "  end",
      "",
      "  def helper",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(tests(summaries).map((one) => one.identity.name)).toEqual([
      "OrderTest > test_cancels_twice",
      "OrderTest > test_audits",
    ]);
    expect(
      linkedCalls(testNamed(summaries, "OrderTest > test_audits")),
    ).toEqual(["Order.audit"]);
  });

  it("reads a class that reaches a test case through a project base", async () => {
    write("test/test_helper.rb", [
      "class ApplicationTest < ActiveSupport::TestCase",
      "end",
    ]);
    write("test/models/order_test.rb", [
      "class OrderTest < ApplicationTest",
      "  def test_cancels",
      "    Order.cancel(1)",
      "  end",
      "end",
      "",
      "class NotATest",
      "  def test_nothing",
      "  end",
      "end",
    ]);

    expect(tests(await extract()).map((one) => one.identity.name)).toEqual([
      "OrderTest > test_cancels",
    ]);
  });

  it("runs the class's setup block and setup method before each test, and leaves assertions out", async () => {
    write("test/models/order_test.rb", [
      "class OrderTest < Minitest::Test",
      "  setup do",
      "    Order.build(1)",
      "  end",
      "",
      "  def setup",
      "    Order.audit(1)",
      "  end",
      "",
      "  def test_cancels",
      "    assert_equal 1, Order.cancel(1)",
      "  end",
      "end",
    ]);

    const test = testNamed(await extract(), "OrderTest > test_cancels");

    expect(linkedCalls(test).sort()).toEqual([
      "Order.audit",
      "Order.build",
      "Order.cancel",
    ]);
    expect(
      test.transitions.flatMap((transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "invocation" ? [effect.callee] : [],
        ),
      ),
    ).not.toContain("assert_equal");
  });

  it("marks a test with a skip statement, and records a stub against its class's file", async () => {
    write("test/models/order_test.rb", [
      "class OrderTest < ActiveSupport::TestCase",
      '  test "later" do',
      '    skip "not yet"',
      "  end",
      "",
      '  test "stubbed" do',
      "    Order.stub(:cancel, 1) do",
      "      Order.cancel(2)",
      "    end",
      "    Order.expects(:audit)",
      "    Order.stubs(method_name)",
      "  end",
      "end",
    ]);

    const summaries = await extract();

    expect(
      readTestMetadata(testNamed(summaries, "OrderTest > test_later"))?.skipped,
    ).toBe(true);
    expect(
      readTestMetadata(testNamed(summaries, "OrderTest > test_stubbed"))?.mocks,
    ).toEqual([
      {
        module: "app/models/order.rb",
        name: "cancel",
        written: "Order.stub(:cancel, 1)",
      },
      {
        module: "app/models/order.rb",
        name: "audit",
        written: "Order.expects(:audit)",
      },
    ]);
  });

  it("reads only the listed files, and nothing without the pack", async () => {
    write("test/models/order_test.rb", [
      "class OrderTest < Minitest::Test",
      "  def test_one",
      "  end",
      "end",
    ]);
    write("test/models/other_test.rb", [
      "class OtherTest < Minitest::Test",
      "  def test_two",
      "  end",
      "end",
    ]);

    expect(
      tests(await extract([minitestPack(["test/models/order_test.rb"])])).map(
        (one) => one.identity.name,
      ),
    ).toEqual(["OrderTest > test_one"]);
    expect(tests(await extract([]))).toEqual([]);
  });
});
