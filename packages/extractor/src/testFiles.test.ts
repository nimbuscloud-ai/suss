import { describe, expect, it } from "vitest";

import { isListedTestFile, matchesTestFileName } from "./testFiles.js";

describe("isListedTestFile", () => {
  it("reads every file when there is no list", () => {
    expect(isListedTestFile("/repo/tests/test_orders.py", undefined)).toBe(
      true,
    );
  });

  it("matches on whole path segments from the end", () => {
    const listed = ["tests/test_orders.py", "./spec/orders_spec.rb"];
    expect(isListedTestFile("/repo/api/tests/test_orders.py", listed)).toBe(
      true,
    );
    expect(isListedTestFile("/repo/spec/orders_spec.rb", listed)).toBe(true);
    expect(
      isListedTestFile("/repo/api/tests/other_test_orders.py", listed),
    ).toBe(false);
  });

  it("matches a Windows path written with backslashes", () => {
    expect(
      isListedTestFile("C:\\repo\\tests\\test_orders.py", [
        "tests/test_orders.py",
      ]),
    ).toBe(true);
  });
});

describe("matchesTestFileName", () => {
  it("matches the base name against each pattern", () => {
    const patterns = ["test_*.py", "*_test.py"];
    expect(matchesTestFileName("/repo/tests/test_orders.py", patterns)).toBe(
      true,
    );
    expect(matchesTestFileName("/repo/orders_test.py", patterns)).toBe(true);
    expect(matchesTestFileName("/repo/test_helpers/orders.py", patterns)).toBe(
      false,
    );
  });

  it("treats a dot in a pattern as a dot", () => {
    expect(matchesTestFileName("orders_specXrb", ["*_spec.rb"])).toBe(false);
  });
});
