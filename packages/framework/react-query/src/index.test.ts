import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { reactFramework } from "@suss/framework-react";
import { createTestProject } from "@suss/test-project";

import { reactQueryFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const QUERY_TYPES: Readonly<Record<string, string>> = {
  "/node_modules/@tanstack/react-query/package.json": JSON.stringify({
    name: "@tanstack/react-query",
    types: "index.d.ts",
  }),
  "/node_modules/@tanstack/react-query/index.d.ts": `
    export declare function useQuery(options: unknown): unknown;
    export declare function useMutation(fn?: unknown, options?: unknown): unknown;
    export declare function useInfiniteQuery(options: unknown): unknown;
  `,
};

async function extract(
  source: string,
  packs: PatternPack[] = [reactQueryFramework()],
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [file, text] of Object.entries(QUERY_TYPES)) {
    project.createSourceFile(file, text);
  }
  project.createSourceFile("/app/Orders.tsx", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: packs,
  });
  return await adapter.extractAll();
}

interface ScheduleRecord {
  unit: string;
  via: string;
  callbackRef: { type: string; name?: string; reason?: string };
}

function schedules(summaries: BehavioralSummary[]): ScheduleRecord[] {
  const out: ScheduleRecord[] = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type === "interaction" &&
          effect.interaction?.class === "schedule" &&
          effect.binding.recognition === "react-query"
        ) {
          out.push({
            unit: summary.identity.name,
            via: effect.interaction.via,
            callbackRef: effect.interaction.callbackRef,
          });
        }
      }
    }
  }
  return out;
}

describe("the react-query pack", () => {
  it("records which function a useQuery call runs, standing alone", async () => {
    const summaries = await extract(`
      import { useQuery } from "@tanstack/react-query";

      async function fetchOrders() {
        return [];
      }

      export function OrderList() {
        const q = useQuery({ queryKey: ["orders"], queryFn: fetchOrders });
        return <ul>{String(q)}</ul>;
      }
    `);

    const found = schedules(summaries);
    expect(found).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useQuery",
      callbackRef: { type: "identifier", name: "fetchOrders" },
    });
  });

  it("makes an inline queryFn a sub-unit under the react component", async () => {
    const summaries = await extract(
      `
      import { useQuery } from "@tanstack/react-query";

      export function OrderList() {
        const q = useQuery({
          queryKey: ["orders"],
          queryFn: async () => {
            return [];
          },
        });
        return <ul>{String(q)}</ul>;
      }
    `,
      [reactFramework(), reactQueryFramework()],
    );

    const subUnit = summaries.find((one) =>
      one.identity.name.includes("useQuery#0"),
    );
    expect(subUnit).toBeDefined();
    expect(subUnit?.kind).toBe("scheduled-callback");

    expect(schedules(summaries)).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useQuery",
      callbackRef: { type: "literal" },
    });
  });

  it("reads the v3 positional mutation function", async () => {
    const summaries = await extract(`
      import { useMutation } from "@tanstack/react-query";

      async function postOrder() {
        return null;
      }

      export function NewOrder() {
        const m = useMutation(postOrder);
        return <button>{String(m)}</button>;
      }
    `);

    expect(schedules(summaries)).toContainEqual({
      unit: expect.stringContaining("NewOrder"),
      via: "useMutation",
      callbackRef: { type: "identifier", name: "postOrder" },
    });
  });

  it("reads an aliased import and a shorthand queryFn property", async () => {
    const summaries = await extract(`
      import { useQuery as useOrders } from "@tanstack/react-query";

      async function queryFn() {
        return [];
      }

      export function OrderList() {
        const q = useOrders({ queryKey: ["orders"], queryFn });
        return <ul>{String(q)}</ul>;
      }
    `);

    expect(schedules(summaries)).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useOrders",
      callbackRef: { type: "identifier", name: "queryFn" },
    });
  });

  it("records a function it cannot resolve as opaque", async () => {
    const summaries = await extract(`
      import { useQuery } from "@tanstack/react-query";
      import { api } from "./api";

      export function OrderList() {
        const q = useQuery({ queryKey: ["orders"], queryFn: api.fetchOrders });
        const bare = useQuery({ queryKey: ["bare"] });
        return <ul>{String(q)}{String(bare)}</ul>;
      }
    `);

    const found = schedules(summaries);
    expect(found).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useQuery",
      callbackRef: { type: "opaque", reason: "non-literal-query-function" },
    });
    expect(found).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useQuery",
      callbackRef: { type: "opaque", reason: "missing-query-function" },
    });
  });

  it("reads the v3 positional query function after the key", async () => {
    const summaries = await extract(
      `
      import { useQuery } from "@tanstack/react-query";

      export function OrderList() {
        const q = useQuery(["orders"], async () => {
          return [];
        });
        return <ul>{String(q)}</ul>;
      }
    `,
      [reactFramework(), reactQueryFramework()],
    );

    expect(schedules(summaries)).toContainEqual({
      unit: expect.stringContaining("OrderList"),
      via: "useQuery",
      callbackRef: { type: "literal" },
    });
    expect(
      summaries.find((one) => one.identity.name.includes("useQuery#0")),
    ).toBeDefined();
  });

  it("ignores a local function that happens to share the hook's name", async () => {
    const summaries = await extract(`
      function useQuery(options: unknown) {
        return options;
      }

      export function OrderList() {
        const q = useQuery({ queryFn: () => [] });
        return <ul>{String(q)}</ul>;
      }
    `);

    expect(schedules(summaries)).toEqual([]);
  });
});
