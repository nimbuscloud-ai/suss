import { describe, expect, it } from "vitest";

import { consumer } from "../__fixtures__/pairs.js";
import { isTestCode, isTestFile } from "./testCode.js";

describe("isTestFile", () => {
  it.each([
    "src/utils/fetch.spec.ts",
    "tests/links/bulk-delete-link.test.ts",
    "src/middlewares/__tests__/csp.ts",
    "src/__mocks__/api.ts",
    "test/client-oauth2.ts",
    "spec/requests/orders_spec.rb",
    "app/orders/test_views.py",
    "app/orders/views_test.py",
    "e2e/checkout.ts",
    "conftest.py",
    "cmd/server/main_test.go",
  ])("reads %s as test code", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each([
    "src/routes/orders.ts",
    "app/api/test/route.ts",
    "src/testing-library.ts",
    "app/controllers/specs_controller.rb",
    "src/contest.py",
  ])("reads %s as production code", (file) => {
    expect(isTestFile(file)).toBe(false);
  });
});

describe("isTestCode", () => {
  it("reads a test case as test code wherever it lives", () => {
    const summary = { ...consumer("checkout", []), kind: "test" as const };
    expect(isTestCode(summary)).toBe(true);
  });

  it("reads a client in a source file as production code", () => {
    expect(isTestCode(consumer("checkout", []))).toBe(false);
  });
});
