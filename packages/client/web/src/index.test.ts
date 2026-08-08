import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { webFetchPack } from "./index.js";

describe("webFetchPack — pack shape", () => {
  it("exposes a consumer discovery pattern for global fetch", async () => {
    const pack = webFetchPack();
    expect(pack.name).toBe("fetch");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].kind).toBe("client");
    expect(pack.discovery[0].match.type).toBe("clientCall");
    expect(pack.terminals).toHaveLength(2);
    expect(pack.inputMapping.type).toBe("positionalParams");
  });
});

describe("webFetchPack — integration", () => {
  it("discovers a function that calls fetch() with literal URL", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getUser(id: string) {
        const res = await fetch("/users/1");
        if (!res.ok) {
          throw new Error("failed");
        }
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [webFetchPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("client");
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "fetch",
    });
  });

  it("extracts method from options object", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function createUser(data: any) {
        const res = await fetch("/users", { method: "POST", body: JSON.stringify(data) });
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [webFetchPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    const sem = summaries[0].identity.boundaryBinding?.semantics;
    expect(sem?.name).toBe("rest");
    if (sem?.name === "rest") {
      expect(sem.method).toBe("POST");
      expect(sem.path).toBe("/users");
    }
  });

  it("produces transitions from branches in the consumer function", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadData() {
        const res = await fetch("/data");
        if (!res.ok) {
          throw new Error("request failed");
        }
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [webFetchPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].transitions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("webFetchPack — fixtures", () => {
  it("summarizes the ALB fixture's client on the order path, not the absolute URL it calls", async () => {
    // fetchOrder.ts calls `fetch("https://shop.example.com/api/orders/123")`.
    // Only a summary keyed on /api/orders/123 can ever pair with the ECS
    // service that serves it, since the provider side never gives the
    // scheme or host.
    const fixturesDir = path.resolve(__dirname, "../../../../fixtures/aws-alb");
    const project = createFixtureProject(fixturesDir, "src/client/*.ts");
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [webFetchPack()],
    });
    const summaries = await adapter.extractAll();
    const fetchOrder = summaries.find((s) => s.identity.name === "fetchOrder");
    expect(fetchOrder?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/api/orders/123" },
      recognition: "fetch",
    });
  });
});
