import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { discoverTestCases } from "./testCase.js";

import type { TestCaseMatch } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

// An invented runner, so the handler is read against the match alone.
const RUNNER: TestCaseMatch = {
  type: "testCase",
  style: "block",
  importModule: "check-runner",
  suiteNames: ["group"],
  caseNames: ["check", "verify"],
  skipModifiers: ["skip", "todo"],
  argumentModifiers: ["when"],
  rowModifiers: ["table"],
  mocks: {
    object: "stub",
    moduleMethods: ["module"],
    memberMethods: ["member"],
  },
};

function discover(
  files: Record<string, string>,
  file: string,
  match: TestCaseMatch = RUNNER,
): DiscoveredUnit[] {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const sourceFile = project.getSourceFileOrThrow(file);
  return discoverTestCases(sourceFile, match, "test");
}

function test(units: readonly DiscoveredUnit[], name: string) {
  const found = units.find((one) => one.name === name);
  if (found === undefined) {
    throw new Error(
      `no case ${name}; found ${units.map((one) => one.name).join(", ")}`,
    );
  }
  return found.metadata?.test as Record<string, unknown>;
}

describe("discoverTestCases", () => {
  it("names each case by its group titles and its own, as a label", () => {
    const units = discover(
      {
        "/repo/orders.check.ts": `
          import { group, check as it } from "check-runner";
          const TITLE = "cancel";
          group("orders", () => {
            group(TITLE, () => {
              it("marks it cancelled", () => {});
            });
          });
        `,
      },
      "/repo/orders.check.ts",
    );

    expect(units.map((one) => [one.name, one.nameKind, one.kind])).toEqual([
      ["orders > cancel > marks it cancelled", "label", "test"],
    ]);
    expect(units[0].func).not.toBeNull();
  });

  it("finds nothing in a file that does not import the runner", () => {
    const units = discover(
      {
        "/repo/a.ts": `
          function check(title: string, fn: () => void) {}
          check("looks like a case", () => {});
        `,
      },
      "/repo/a.ts",
    );
    expect(units).toEqual([]);
  });

  it("walks only the listed files, matched on whole segments from the end", () => {
    const source = `
      import { check } from "check-runner";
      check("runs", () => {});
    `;
    const files = {
      "/repo/src/a.check.ts": source,
      "/repo/src/ba.check.ts": source,
    };
    const listed = { ...RUNNER, files: ["./src/a.check.ts"] };

    expect(discover(files, "/repo/src/a.check.ts", listed)).toHaveLength(1);
    expect(discover(files, "/repo/src/ba.check.ts", listed)).toEqual([]);
  });

  it("marks a case skipped by its own modifier or its group's, and keeps a case with no body", () => {
    const units = discover(
      {
        "/repo/a.check.ts": `
          import { group, check } from "check-runner";
          group.skip("refunds", () => {
            check("inherits the skip", () => {});
          });
          check.todo("is not written yet");
          check("runs", () => {});
        `,
      },
      "/repo/a.check.ts",
    );

    expect(test(units, "refunds > inherits the skip").skipped).toBe(true);
    expect(test(units, "is not written yet").skipped).toBe(true);
    expect(test(units, "runs").skipped).toBeUndefined();
    const todo = units.find((one) => one.name === "is not written yet");
    expect(todo?.func).toBeNull();
    expect(todo?.announcedAt).toBeDefined();
  });

  it("follows a modifier that returns the case function, and marks a per-row title unresolved", () => {
    const units = discover(
      {
        "/repo/a.check.ts": `
          import { check } from "check-runner";
          declare const ci: boolean;
          check.when(ci)("runs in CI", () => {});
          check.table([[1], [2]])("adds %s", (n: number) => {});
        `,
      },
      "/repo/a.check.ts",
    );

    expect(test(units, "runs in CI").unresolvedTitle).toBeUndefined();
    expect(test(units, "adds %s").unresolvedTitle).toBe("adds %s");
    expect(units).toHaveLength(2);
  });

  it("keeps a title it cannot read as written, and says so", () => {
    const units = discover(
      {
        "/repo/a.check.ts": `
          import { group, check } from "check-runner";
          declare const name: string;
          group(name, () => {
            check("runs", () => {});
          });
        `,
      },
      "/repo/a.check.ts",
    );

    expect(units[0].name).toBe("name > runs");
    expect(test(units, "name > runs").unresolvedTitle).toBe("name");
  });

  it("resolves a relative module mock to the project file, whether or not the file imports it", () => {
    const units = discover(
      {
        "/repo/src/orders.ts": "export const cancel = () => 1;",
        "/repo/src/refunds/index.ts": "export const refund = () => 1;",
        "/repo/src/orders.check.ts": `
          import { check, stub } from "check-runner";
          stub.module("./orders.js", () => ({ cancel: () => 2 }));
          stub.module("./refunds");
          stub.module("left-pad");
          stub.module("./missing.js");
          check("cancels", () => {});
        `,
      },
      "/repo/src/orders.check.ts",
    );

    expect(test(units, "cancels").mocks).toEqual([
      { module: "/repo/src/orders.ts", written: 'stub.module("./orders.js")' },
      {
        module: "/repo/src/refunds/index.ts",
        written: 'stub.module("./refunds")',
      },
      { module: "left-pad", written: 'stub.module("left-pad")' },
      { module: "./missing.js", written: 'stub.module("./missing.js")' },
    ]);
  });

  it("gives a member mock the module when the object is a module imported whole", () => {
    const units = discover(
      {
        "/repo/src/orders.ts": "export const cancel = () => 1;",
        "/repo/src/orders.check.ts": `
          import { check, stub } from "check-runner";
          import * as orders from "./orders";
          declare const clock: { now(): number };
          check("cancels", () => {
            stub.member(orders, "cancel");
            stub
              .member(clock, "now");
          });
        `,
      },
      "/repo/src/orders.check.ts",
    );

    expect(test(units, "cancels").mocks).toEqual([
      {
        module: "/repo/src/orders.ts",
        name: "cancel",
        written: 'stub.member(orders, "cancel")',
      },
      { name: "now", written: 'stub.member(clock, "now")' },
    ]);
  });

  it("applies a mock inside one case to that case, and one in a group to the cases under it", () => {
    const units = discover(
      {
        "/repo/a.check.ts": `
          import { group, check, verify, stub } from "check-runner";
          group("orders", () => {
            stub.module("left-pad");
            check("sees the group's mock", () => {});
          });
          verify("sees none", () => {});
          check("has its own", () => { stub.module("right-pad"); });
          declare const name: string;
          check("skips a mock it cannot read", () => { stub.module(name); });
        `,
      },
      "/repo/a.check.ts",
    );

    const modules = (name: string) =>
      ((test(units, name).mocks ?? []) as Array<{ module?: string }>).map(
        (mock) => mock.module,
      );
    expect(modules("orders > sees the group's mock")).toEqual(["left-pad"]);
    expect(modules("sees none")).toEqual([]);
    expect(modules("has its own")).toEqual(["right-pad"]);
    expect(modules("skips a mock it cannot read")).toEqual([]);
  });

  it("reads no mocks for a runner that declares none", () => {
    const { mocks: _mocks, ...withoutMocks } = RUNNER;
    const units = discover(
      {
        "/repo/a.check.ts": `
          import { check, stub } from "check-runner";
          stub.module("left-pad");
          check("runs", () => {});
        `,
      },
      "/repo/a.check.ts",
      withoutMocks,
    );
    expect(test(units, "runs").mocks).toBeUndefined();
  });
});
