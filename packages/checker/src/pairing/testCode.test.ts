import { describe, expect, it } from "vitest";

import { consumer } from "../__fixtures__/pairs.js";
import { isTestCode } from "./testCode.js";

describe("isTestCode", () => {
  it("reads a test case as test code wherever it lives", () => {
    const summary = { ...consumer("checkout", []), kind: "test" as const };
    expect(isTestCode(summary)).toBe(true);
  });

  it("reads a Storybook story as test code wherever it lives", () => {
    const summary = {
      ...consumer("Primary", []),
      metadata: { component: { storybook: { story: "Primary" } } },
    };
    expect(isTestCode(summary)).toBe(true);
  });

  it("reads a client in a source file as production code", () => {
    expect(isTestCode(consumer("checkout", []))).toBe(false);
  });

  it("reads a unit the extract marked as test code, whatever its path", () => {
    const summary = consumer("checkout", []);
    const marked = {
      ...summary,
      location: {
        ...summary.location,
        file: "packages/api/test/client.ts",
        inTests: true,
      },
    };
    expect(isTestCode(marked)).toBe(true);
  });
});
