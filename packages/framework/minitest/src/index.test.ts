import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { readTestMetadata } from "@suss/behavioral-ir";

import { declares, minitestFramework, optionsSchema } from "./index.js";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/covered-by-minitest",
);

async function extract(files?: string[]) {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(fixtureRoot),
    packs: [minitestFramework(files === undefined ? {} : { files })],
    workspaceRoot: fixtureRoot,
    cacheDir: null,
  });
  return summaries.filter((one) => one.kind === "test");
}

describe("minitestFramework", () => {
  it("discovers no routes and reads test files as test classes", () => {
    const pack = minitestFramework();
    const cases = pack.testClasses?.[0]?.cases;
    expect(pack.discovery).toEqual([]);
    expect(cases?.files.matching).toEqual(["*_test.rb"]);
    expect(cases?.classes?.inherits).toContainEqual({
      from: ["ActiveSupport"],
      named: ["TestCase"],
    });
    expect(cases?.classes?.inherits).toContainEqual({
      from: ["ActionCable::Channel"],
      named: ["TestCase"],
    });
  });

  it("states the method a test block defines, only in a test class", () => {
    const [tests] = minitestFramework().classBodies ?? [];
    expect(tests?.in).toEqual(
      minitestFramework().testClasses?.[0]?.cases.classes?.inherits,
    );
    expect(tests?.calls.test).toMatchObject({
      declares: "method",
      body: { block: true },
      kind: "instance",
    });
  });

  it("takes a file list and nothing else, and suggests itself to no project", () => {
    expect(optionsSchema.safeParse({ files: ["a_test.rb"] }).success).toBe(
      true,
    );
    expect(optionsSchema.safeParse({ file: "x" }).success).toBe(false);
    expect(declares.dependencies).toEqual([]);
  });

  it("reads the fixture's tests, whether each runs, and what it stubs", async () => {
    const tests = (await extract()).map((one) => ({
      name: one.identity.name,
      skipped: readTestMetadata(one)?.skipped === true,
      mocks: (readTestMetadata(one)?.mocks ?? []).map((mock) => mock.name),
    }));

    expect(tests).toContainEqual({
      name: "OrderTest > test_cancels_twice_without_harm",
      skipped: true,
      mocks: [],
    });
    expect(tests).toContainEqual({
      name: "CheckoutTest > test_cancels_on_a_failed_checkout",
      skipped: false,
      mocks: ["cancel"],
    });
  });

  it("reads only the listed test files", async () => {
    const files = new Set(
      (await extract(["test/services/checkout_test.rb"])).map(
        (one) => one.location.file,
      ),
    );
    expect([...files]).toEqual(["test/services/checkout_test.rb"]);
  });
});
