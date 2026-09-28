import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { readTestMetadata } from "@suss/behavioral-ir";

import { declares, optionsSchema, pytestFramework } from "./index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "covered-by-pytest");

async function extractFixture(files?: string[]) {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(fixtureRoot),
    packs: [pytestFramework(files === undefined ? {} : { files })],
    roots: [fixtureRoot],
    workspaceRoot: fixtureRoot,
    cacheDir: null,
  });
  return summaries;
}

describe("pytestFramework", () => {
  it("reads every collected test when no files are given", async () => {
    const tests = (await extractFixture()).filter((one) => one.kind === "test");
    expect(
      tests.map((one) => `${one.location.file}::${one.identity.name}`).sort(),
    ).toEqual([
      "tests/test_checkout.py::test_cancels_on_a_failed_checkout",
      "tests/test_orders.py::TestCancel > test_cancels_twice_without_harm",
      "tests/test_orders.py::TestCancel > test_marks_the_order_cancelled",
      "tests/test_orders.py::TestCancel > test_refunds_the_payment",
      "tests/test_orders.py::test_reads_a_cancelled_order",
      "tests/test_unlisted.py::test_is_never_read",
    ]);
  });

  it("reads only the listed files when given a list", async () => {
    const files = new Set(
      (await extractFixture(["tests/test_checkout.py"]))
        .filter((one) => one.kind === "test")
        .map((one) => one.location.file),
    );
    expect([...files]).toEqual(["tests/test_checkout.py"]);
  });

  it("records a skip marker and a patch", async () => {
    const summaries = await extractFixture();
    const named = (name: string) =>
      summaries.find((one) => one.identity.name === name);

    expect(
      readTestMetadata(
        named("TestCancel > test_cancels_twice_without_harm") ?? summaries[0],
      )?.skipped,
    ).toBe(true);
    expect(
      readTestMetadata(
        named("test_cancels_on_a_failed_checkout") ?? summaries[0],
      )?.mocks,
    ).toEqual([
      {
        module: "app/orders.py",
        name: "cancel_order",
        written: 'patch("app.checkout.cancel_order")',
      },
    ]);
  });

  it("re-reads the tests when a conftest.py changes", () => {
    const pack = pytestFramework();
    expect(
      pack.discoveryInputs?.([
        "/repo/tests/conftest.py",
        "/repo/app/orders.py",
      ]),
    ).toEqual(["/repo/tests/conftest.py"]);
  });

  it("takes a file list and nothing else, and suggests itself to no project", () => {
    expect(optionsSchema.safeParse({ files: ["a.py"] }).success).toBe(true);
    expect(optionsSchema.safeParse({ other: true }).success).toBe(false);
    expect(declares.dependencies).toEqual([]);
  });
});
