import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary, Predicate } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const fetchPack: PatternPack = {
  name: "fetch",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "global",
        importName: "fetch",
      },
      bindingExtraction: {
        method: {
          type: "fromArgumentProperty",
          position: 1,
          property: "method",
          default: "GET",
        },
        path: { type: "fromArgument", position: 0 },
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
  responseSemantics: [
    {
      name: "ok",
      access: "property",
      semantics: { type: "statusRange", min: 200, max: 299 },
    },
    { name: "status", access: "property", semantics: { type: "statusCode" } },
    { name: "json", access: "method", semantics: { type: "body" } },
  ],
};

async function clientsIn(
  files: Record<string, string>,
): Promise<Map<string, BehavioralSummary>> {
  const project = createTestProject();
  for (const [name, text] of Object.entries(files)) {
    project.createSourceFile(name, text);
  }
  const adapter = createTypeScriptAdapter({ project, frameworks: [fetchPack] });
  const summaries = await adapter.extractAll();
  return new Map(
    summaries
      .filter((s) => s.kind === "client")
      .map((s) => [s.identity.name, s]),
  );
}

/** Each transition as its output kind and the conditions on it, for comparing two callers. */
function outline(summary: BehavioralSummary | undefined): string[] {
  return (summary?.transitions ?? []).map(
    (t) => `${t.output.type} ${JSON.stringify(t.conditions)}`,
  );
}

function testsFetchStatus(p: Predicate): boolean {
  const text = JSON.stringify(p);
  return text.includes('"name":"fetch"') && text.includes('"status"');
}

describe("a client caller that hands its response to a helper", () => {
  const readOrder = `
    export async function readOrder(response: Response) {
      if (!response.ok) {
        throw new Error("request failed");
      }
      const body = (await response.json()) as { data: { id: string } };
      return body.data;
    }
  `;

  it("reads the helper's status test and throw as its own", async () => {
    const clients = await clientsIn({
      "client.ts": `
        ${readOrder}
        export async function getOrder(id: string) {
          const response = await fetch(\`/api/orders/\${id}\`);
          return readOrder(response);
        }
        export async function getOrderInline(id: string) {
          const response = await fetch(\`/api/orders/\${id}\`);
          if (!response.ok) {
            throw new Error("request failed");
          }
          return response.json();
        }
      `,
    });

    const handedOff = clients.get("getOrder");
    const thrown = handedOff?.transitions.find(
      (t) => t.output.type === "throw",
    );
    expect(thrown?.conditions.some(testsFetchStatus)).toBe(true);
    expect(thrown?.isDefault).toBe(false);
    const returned = handedOff?.transitions.find(
      (t) => t.output.type === "return",
    );
    expect(returned?.isDefault).toBe(true);
    expect(returned?.conditions.some(testsFetchStatus)).toBe(true);
    expect(outline(handedOff).map((line) => line.split(" ")[0])).toEqual(
      outline(clients.get("getOrderInline")).map((line) => line.split(" ")[0]),
    );
  });

  it("follows a helper imported from another file", async () => {
    const clients = await clientsIn({
      "readOrder.ts": readOrder,
      "client.ts": `
        import { readOrder } from "./readOrder";
        export async function getOrder(id: string) {
          const response = await fetch(\`/api/orders/\${id}\`, { method: "GET" });
          return readOrder(response);
        }
      `,
    });

    const thrown = clients
      .get("getOrder")
      ?.transitions.find((t) => t.output.type === "throw");
    expect(thrown?.conditions.some(testsFetchStatus)).toBe(true);
  });

  it("follows a guard called as a statement before the caller goes on", async () => {
    const clients = await clientsIn({
      "client.ts": `
        async function ensureOk(res: Response): Promise<void> {
          if (res.status >= 400) {
            throw new Error("request failed");
          }
        }
        export async function deleteOrder(id: string) {
          const res = await fetch(\`/api/orders/\${id}\`, { method: "DELETE" });
          await ensureOk(res);
          return true;
        }
      `,
    });

    const outcomes = outline(clients.get("deleteOrder"));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((line) => line.startsWith("throw"))).toHaveLength(1);
    expect(outcomes.every((line) => line.includes('"status"'))).toBe(true);
  });

  it("follows a helper handed the parsed body", async () => {
    const clients = await clientsIn({
      "client.ts": `
        function unwrap(payload: { error?: string; data?: string }) {
          if (payload.error) {
            throw new Error(payload.error);
          }
          return payload.data;
        }
        export async function getOrder(id: string) {
          const res = await fetch(\`/api/orders/\${id}\`);
          const payload = await res.json();
          return unwrap(payload);
        }
      `,
    });

    const thrown = clients
      .get("getOrder")
      ?.transitions.find((t) => t.output.type === "throw");
    expect(JSON.stringify(thrown?.conditions)).toContain('"res.json"');
    expect(JSON.stringify(thrown?.conditions)).toContain('"error"');
    const returned = clients
      .get("getOrder")
      ?.transitions.find((t) => t.output.type === "return");
    expect(returned?.expectedInput).toEqual({
      type: "record",
      properties: {
        json: {
          type: "record",
          properties: { error: { type: "unknown" }, data: { type: "unknown" } },
        },
      },
    });
  });

  it("leaves the caller alone when the helper never tests the response", async () => {
    const clients = await clientsIn({
      "client.ts": `
        declare function record(value: unknown): void;
        function logResponse(response: Response, label: string) {
          if (label.length > 0) {
            record(response);
          }
        }
        export async function getOrder(id: string) {
          const response = await fetch(\`/api/orders/\${id}\`);
          logResponse(response, "order");
          return response;
        }
      `,
    });

    expect(outline(clients.get("getOrder"))).toEqual(["return []"]);
  });

  it("leaves a helper alone when it is handed a field read off the body", async () => {
    const clients = await clientsIn({
      "client.ts": `
        function formatTotal(value: number) {
          if (!Number.isFinite(value)) {
            throw new Error("not a number");
          }
          return value.toFixed(2);
        }
        export async function getTotal(id: string) {
          const res = await fetch(\`/api/orders/\${id}\`);
          const payload = await res.json();
          return formatTotal(payload.total);
        }
      `,
    });

    expect(outline(clients.get("getTotal"))).toHaveLength(1);
  });

  it("gives a caller of a wrapper that throws on every failure the wrapper's throw", async () => {
    const clients = await clientsIn({
      "client.ts": `
        async function request<T>(url: string, init: RequestInit): Promise<T> {
          const response = await fetch(url, init);
          if (!response.ok) {
            throw new Error("request failed");
          }
          return ((await response.json()) as { data: T }).data;
        }
        export async function getOrders(accountId: string) {
          return request<string[]>(\`/api/orders?account=\${accountId}\`, {
            method: "GET",
          });
        }
      `,
    });

    const caller = clients.get("getOrders");
    expect(caller?.metadata?.http).toMatchObject({
      failureDelivery: "exception",
    });
    const thrown = caller?.transitions.find((t) => t.output.type === "throw");
    expect(thrown?.conditions.some(testsFetchStatus)).toBe(true);
  });

  it("leaves failures with a wrapper's caller when the wrapper returns on one", async () => {
    const clients = await clientsIn({
      "client.ts": `
        async function request<T>(url: string): Promise<T | null> {
          const response = await fetch(url, { method: "GET" });
          if (response.status === 404) {
            return null;
          }
          if (!response.ok) {
            throw new Error("request failed");
          }
          return (await response.json()) as T;
        }
        export async function getOrder(id: string) {
          return request<string>(\`/api/orders/\${id}\`);
        }
      `,
    });

    const caller = clients.get("getOrder");
    expect(caller).toBeDefined();
    expect(JSON.stringify(caller?.metadata)).not.toContain("failureDelivery");
    expect(
      caller?.transitions.filter((t) => t.output.type === "return"),
    ).toHaveLength(2);
  });

  it("leaves a helper call alone when it is handed something else", async () => {
    const clients = await clientsIn({
      "client.ts": `
        function checkId(id: string) {
          if (id.length === 0) {
            throw new Error("no id");
          }
        }
        export async function getOrder(id: string) {
          const response = await fetch(\`/api/orders/\${id}\`);
          checkId(id);
          return response;
        }
      `,
    });

    expect(outline(clients.get("getOrder"))).toEqual(["return []"]);
  });
});
