import { describe, expect, it } from "vitest";

import { testUnitName } from "./testName.js";

describe("testUnitName", () => {
  it("joins the suite titles and the test's own with the separator", () => {
    expect(testUnitName(["TestCancel", "test_second_time"])).toBe(
      "TestCancel > test_second_time",
    );
  });
});
