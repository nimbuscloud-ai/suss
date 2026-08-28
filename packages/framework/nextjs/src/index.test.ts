import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { nextjsFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/nextjs");

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "**/*.ts");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [nextjsFramework()],
  });

  return await adapter.extractAll();
}

function routeOf(summary: BehavioralSummary): string {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "rest") {
    return "<not a route>";
  }
  return `${binding.semantics.method} ${binding.semantics.path}`;
}

function statusesOf(summary: BehavioralSummary): number[] {
  const codes: number[] = [];
  for (const t of summary.transitions) {
    if (
      t.output.type === "response" &&
      t.output.statusCode?.type === "literal"
    ) {
      codes.push(t.output.statusCode.value as number);
    }
  }
  return codes.sort((a, b) => a - b);
}

describe("nextjsFramework: pack shape", () => {
  it("finds route files by where they sit, not by an import", () => {
    const pack = nextjsFramework();
    expect(pack.name).toBe("nextjs");
    expect(pack.discovery.map((d) => d.match.type)).toEqual([
      "fileConvention",
      "fileConvention",
    ]);
  });
});

describe("nextjsFramework: extraction", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("reads one handler per method a route file exports", () => {
    expect(summaries.map(routeOf).sort()).toEqual([
      "* /api/legacy",
      "DELETE /api/orders/{id}",
      "GET /api/orders",
      "GET /api/orders/{id}",
      "POST /api/orders",
    ]);
  });

  it("reads a response the handler constructs", () => {
    const post = summaries.find(
      (s) => routeOf(s) === "POST /api/orders",
    ) as BehavioralSummary;
    expect(statusesOf(post)).toEqual([201, 400]);
  });

  it("reads the statuses a handler answers with", () => {
    const get = summaries.find(
      (s) => routeOf(s) === "GET /api/orders/{id}",
    ) as BehavioralSummary;
    expect(statusesOf(get)).toEqual([200, 404]);
  });

  it("takes the status off the init object", () => {
    const del = summaries.find(
      (s) => routeOf(s) === "DELETE /api/orders/{id}",
    ) as BehavioralSummary;
    expect(statusesOf(del)).toEqual([202, 404]);
  });

  it("reads the body a handler sends", () => {
    const list = summaries.find(
      (s) => routeOf(s) === "GET /api/orders",
    ) as BehavioralSummary;
    const ok = list.transitions[0];
    expect(ok.output.type).toBe("response");
    if (ok.output.type === "response") {
      expect(JSON.stringify(ok.output.body)).toContain("orders");
    }
  });

  it("reads a pages handler through the response it was handed", () => {
    const legacy = summaries.find(
      (s) => routeOf(s) === "* /api/legacy",
    ) as BehavioralSummary;
    // The path is right and the statuses are right. There is no method,
    // because one export serves all of them, so this route does not pair with
    // a caller.
    expect(statusesOf(legacy)).toEqual([200, 405]);
  });
});

describe("server actions", () => {
  async function extract(
    files: Record<string, string>,
  ): Promise<BehavioralSummary[]> {
    const project = createTestProject();
    for (const [file, text] of Object.entries(files)) {
      project.createSourceFile(file, text);
    }
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [nextjsFramework()],
    });
    return await adapter.extractAll();
  }

  function actionsOf(summaries: BehavioralSummary[]): string[] {
    return summaries
      .filter((one) => one.kind === "action")
      .map((one) => one.identity.name)
      .sort();
  }

  it("makes every exported function of a use server file an action", async () => {
    const summaries = await extract({
      "/app/actions.ts": `
        "use server";

        export async function createOrder(sku: string, count: number) {
          return { sku, count };
        }

        export const cancelOrder = async (id: string) => {
          return id;
        };

        async function helper() {
          return null;
        }
      `,
    });

    expect(actionsOf(summaries)).toEqual(["cancelOrder", "createOrder"]);
    const bound = summaries.find((one) => one.identity.name === "createOrder");
    expect(bound?.identity.boundaryBinding?.semantics).toMatchObject({
      name: "function-call",
      module: "/app/actions.ts",
      exportName: "createOrder",
    });
    const created = summaries.find(
      (one) => one.identity.name === "createOrder",
    );
    expect(
      created?.inputs.map((input) =>
        input.type === "parameter" ? input.name : input.type,
      ),
    ).toEqual(["sku", "count"]);
  });

  it("reads a function-level directive, inline actions included", async () => {
    const summaries = await extract({
      "/app/page.tsx": `
        export default function Page() {
          const submit = async (data: FormData) => {
            "use server";
            return data;
          };
          return <form action={submit} />;
        }

        export async function alsoServer() {
          "use server";
          return null;
        }
      `,
    });

    expect(actionsOf(summaries)).toEqual(["alsoServer", "submit"]);
  });

  it("names an anonymous inline action by position and a property one by key", async () => {
    const summaries = await extract({
      "/app/form.tsx": `
        export default function Page() {
          const handlers = {
            submit: async (data: FormData) => {
              "use server";
              return data;
            },
          };
          const concise = async () => null;
          return (
            <form
              action={async () => {
                "use server";
                return handlers.submit(new FormData());
              }}
            />
          );
        }
      `,
    });

    expect(actionsOf(summaries)).toEqual(["serverAction#0", "submit"]);
  });

  it("ignores the directive anywhere but the prologue", async () => {
    const summaries = await extract({
      "/app/lib.ts": `
        export function describeDirective() {
          return "use server";
        }
      `,
    });

    expect(actionsOf(summaries)).toEqual([]);
  });
});
