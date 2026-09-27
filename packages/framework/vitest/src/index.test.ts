import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readTestMetadata } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { optionsSchema, vitestFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const ORDERS = `
export function cancelOrder(id: string) {
  return { id, status: "cancelled" };
}
`;

async function extract(
  files: Record<string, string>,
  options: { files?: string[] } = {},
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [vitestFramework(options)],
  });
  return (await adapter.extractAll()).filter((one) => one.kind === "test");
}

function named(
  summaries: readonly BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((one) => one.identity.name === name);
  if (found === undefined) {
    throw new Error(
      `no test named ${name}; found ${summaries.map((one) => one.identity.name).join(", ")}`,
    );
  }
  return found;
}

describe("vitestFramework", () => {
  it("names each case by its suite titles and its own", async () => {
    const tests = await extract({
      "src/orders.ts": ORDERS,
      "src/orders.test.ts": `
        import { describe, expect, it } from "vitest";
        import { cancelOrder } from "./orders";
        describe("orders", () => {
          describe("cancel", () => {
            it("marks the order cancelled", () => {
              expect(cancelOrder("o-1").status).toBe("cancelled");
            });
          });
        });
      `,
    });

    const test = named(tests, "orders > cancel > marks the order cancelled");
    expect(test.identity.boundaryBinding).toBeNull();
    const callees = test.transitions.flatMap((transition) =>
      transition.effects.flatMap((effect) =>
        effect.type === "invocation" ? [effect.callee] : [],
      ),
    );
    expect(callees).toContain("cancelOrder");
  });

  it("follows an aliased import of the runner's functions", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { suite, test as check } from "vitest";
        suite("orders", () => {
          check("lists them", () => {});
        });
      `,
    });

    expect(tests.map((one) => one.identity.name)).toEqual([
      "orders > lists them",
    ]);
  });

  it("marks a case skipped by its own modifier, its suite's, or a todo with no body", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { describe, it } from "vitest";
        describe("orders", () => {
          it.skip("skips itself", () => {});
          it.todo("is not written yet");
          it("runs", () => {});
        });
        describe.skip("refunds", () => {
          it("skips with its suite", () => {});
        });
      `,
    });

    const skipped = (name: string): boolean =>
      readTestMetadata(named(tests, name))?.skipped === true;
    expect(skipped("orders > skips itself")).toBe(true);
    expect(skipped("orders > is not written yet")).toBe(true);
    expect(skipped("refunds > skips with its suite")).toBe(true);
    expect(skipped("orders > runs")).toBe(false);
  });

  it("reads a case a condition can skip like any other", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { it } from "vitest";
        it.skipIf(process.env.CI)("runs locally", () => {});
      `,
    });

    const test = named(tests, "runs locally");
    expect(readTestMetadata(test)?.skipped).toBeUndefined();
    expect(readTestMetadata(test)?.unresolvedTitle).toBeUndefined();
  });

  it("keeps the pattern as the title of a case declared once per row, and says it is unresolved", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { it } from "vitest";
        it.each([["o-1"], ["o-2"]])("cancels %s", (id) => {});
      `,
    });

    const test = named(tests, "cancels %s");
    expect(readTestMetadata(test)?.unresolvedTitle).toBe("cancels %s");
  });

  it("records a title it cannot read as written", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { it } from "vitest";
        declare const title: string;
        it(title, () => {});
      `,
    });

    expect(readTestMetadata(tests[0])?.unresolvedTitle).toBe("title");
  });

  it("records a module mock as the file it resolves to, for every case in the file", async () => {
    const tests = await extract({
      "/repo/src/orders.ts": ORDERS,
      "/repo/src/orders.test.ts": `
        import { describe, it, vi } from "vitest";
        import { cancelOrder } from "./orders.js";
        vi.mock("./orders.js", () => ({ cancelOrder: () => ({}) }));
        vi.mock("left-pad");
        describe("orders", () => {
          it("cancels", () => { cancelOrder("o-1"); });
        });
      `,
    });

    expect(readTestMetadata(named(tests, "orders > cancels"))?.mocks).toEqual([
      { module: "/repo/src/orders.ts", written: 'vi.mock("./orders.js")' },
      { module: "left-pad", written: 'vi.mock("left-pad")' },
    ]);
  });

  it("applies a mock written inside a case to that case alone", async () => {
    const tests = await extract({
      "src/a.test.ts": `
        import { it, vi } from "vitest";
        declare const clock: { now(): number };
        it("freezes the clock", () => {
          vi.spyOn(clock, "now");
        });
        it("reads the clock", () => {});
      `,
    });

    expect(readTestMetadata(named(tests, "freezes the clock"))?.mocks).toEqual([
      { name: "now", written: 'vi.spyOn(clock, "now")' },
    ]);
    expect(readTestMetadata(named(tests, "reads the clock"))?.mocks).toBe(
      undefined,
    );
  });

  it("records a spy on a module imported whole as that module's member", async () => {
    const tests = await extract({
      "/repo/src/orders.ts": ORDERS,
      "/repo/src/orders.test.ts": `
        import { it, vi } from "vitest";
        import * as orders from "./orders";
        it("cancels", () => {
          vi.spyOn(orders, "cancelOrder");
          orders.cancelOrder("o-1");
        });
      `,
    });

    expect(readTestMetadata(named(tests, "cancels"))?.mocks).toEqual([
      {
        module: "/repo/src/orders.ts",
        name: "cancelOrder",
        written: 'vi.spyOn(orders, "cancelOrder")',
      },
    ]);
  });

  it("reads only the files it is given", async () => {
    const source = `
      import { it } from "vitest";
      it("runs", () => {});
    `;
    const tests = await extract(
      { "src/a.test.ts": source, "src/b.test.ts": source },
      { files: ["src/b.test.ts"] },
    );

    expect(tests.map((one) => one.location.file)).toEqual(["/src/b.test.ts"]);
  });

  it("refuses an option it does not take", () => {
    expect(optionsSchema.safeParse({ folder: "intent/" }).success).toBe(false);
    expect(optionsSchema.safeParse({ files: ["a.test.ts"] }).success).toBe(
      true,
    );
  });
});
