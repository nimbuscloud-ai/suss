import { describe, expect, it } from "vitest";

import { isTestFile } from "./testFiles.js";

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
    "src/components/Button.stories.tsx",
    "src/testing/decorators/RouterDecorator.tsx",
    "src/__fixtures__/orders.ts",
    "src/api/orders.fixture.ts",
    ".storybook/preview.tsx",
    "/repo/app/lib/google.test.ts",
  ])("reads %s as test code", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each([
    "src/routes/orders.ts",
    "app/api/test/route.ts",
    "src/testing-library.ts",
    "app/controllers/specs_controller.rb",
    "src/contest.py",
    "fixtures/react-router/routes.tsx",
    "/repo/test/routes.ts",
  ])("reads %s as production code", (file) => {
    expect(isTestFile(file)).toBe(false);
  });
});
