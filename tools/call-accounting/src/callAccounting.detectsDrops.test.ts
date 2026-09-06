import { Project } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

vi.mock("@suss/adapter-typescript", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@suss/adapter-typescript")>();
  return {
    ...actual,
    // The only shape a healthy corpus never produces: a call the walk
    // reached that fired on no branch despite sitting before one.
    extractRawBranches: (
      ...args: Parameters<typeof actual.extractRawBranches>
    ) => {
      const result = actual.extractRawBranches(...args);
      if (result.callAccounting === undefined) {
        return result;
      }
      return {
        ...result,
        callAccounting: result.callAccounting.map((entry) =>
          entry.callee === "helper"
            ? { ...entry, outcome: "unrecorded" as const }
            : entry,
        ),
      };
    },
  };
});

const { accountForFile, unaccountedCalls } = await import(
  "./callAccounting.js"
);

describe("call accounting: a dropped call", () => {
  it("fails the accounting for a call the walk stopped recording", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      "dropped.ts",
      "function f() {\n  helper();\n  return 1;\n}\n",
    );

    const results = accountForFile(sourceFile);
    const dropped = unaccountedCalls(results);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ callee: "helper", line: 2 });
  });
});
