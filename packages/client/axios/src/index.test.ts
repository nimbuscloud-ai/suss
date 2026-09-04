import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readHttpMetadata } from "@suss/behavioral-ir";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { axiosPack } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

describe("axiosPack — pack shape", () => {
  it("exposes a discovery pattern per HTTP verb", async () => {
    const pack = axiosPack();
    expect(pack.name).toBe("axios");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    // One discovery pattern per HTTP verb: get, post, put, delete, patch, head, options
    expect(pack.discovery).toHaveLength(7);
    for (const d of pack.discovery) {
      expect(d.kind).toBe("client");
      expect(d.match.type).toBe("clientCall");
    }
    expect(pack.terminals).toHaveLength(2);
    expect(pack.inputMapping.type).toBe("positionalParams");
  });

  it("declares response semantics for axios's AxiosResponse shape", async () => {
    const pack = axiosPack();
    const semantics = pack.responseSemantics ?? [];
    const data = semantics.find((s) => s.name === "data");
    expect(data?.semantics.type).toBe("body");
    const status = semantics.find((s) => s.name === "status");
    expect(status?.semantics.type).toBe("statusCode");
  });

  it("says a refused request rejects rather than coming back as a response", async () => {
    expect(axiosPack().failureDelivery).toBe("exception");
  });
});

describe("axiosPack — integration", () => {
  it("discovers axios.get(url) and extracts GET + path from arg 0", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      export async function getUser(id: string) {
        const res = await axios.get("/users/1");
        return res.data;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("client");
    expect(summaries[0].identity.name).toBe("getUser");
    expect(readHttpMetadata(summaries[0])?.failureDelivery).toBe("exception");
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("distinguishes verbs by the called method name", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      export async function createUser(body: any) {
        const res = await axios.post("/users", body);
        return res.data;
      }

      export async function deleteUser(id: string) {
        await axios.delete("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    const post = summaries.find((s) => s.identity.name === "createUser");
    const postSem = post?.identity.boundaryBinding?.semantics;
    expect(postSem?.name).toBe("rest");
    if (postSem?.name === "rest") {
      expect(postSem.method).toBe("POST");
      expect(postSem.path).toBe("/users");
    }

    const del = summaries.find((s) => s.identity.name === "deleteUser");
    const delSem = del?.identity.boundaryBinding?.semantics;
    expect(delSem?.name).toBe("rest");
    if (delSem?.name === "rest") {
      expect(delSem.method).toBe("DELETE");
      expect(delSem.path).toBe("/users/1");
    }
  });

  it("produces transitions for branches in the consumer function", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      export async function loadUser(id: string) {
        const res = await axios.get("/users/1");
        if (res.status === 404) {
          throw new Error("not found");
        }
        return res.data;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].transitions.length).toBeGreaterThanOrEqual(2);
  });

  it("matches calls on instances created via axios.create()", async () => {
    // The dominant production pattern: per-service axios instances created
    // with a baseURL. The pack declares factoryMethods: ["create"] so the
    // adapter treats `api` as a client subject.
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      const api = axios.create({ baseURL: "/api" });

      export async function getUser() {
        return api.get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("matches multiple verbs called on the same axios.create() instance", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      const api = axios.create({ baseURL: "/api" });

      export async function getUser() {
        return api.get("/users/1");
      }

      export async function deleteUser() {
        await api.delete("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(2);
    const get = summaries.find((s) => s.identity.name === "getUser");
    const getSem = get?.identity.boundaryBinding?.semantics;
    expect(getSem?.name === "rest" ? getSem.method : null).toBe("GET");
    const del = summaries.find((s) => s.identity.name === "deleteUser");
    const delSem = del?.identity.boundaryBinding?.semantics;
    expect(delSem?.name === "rest" ? delSem.method : null).toBe("DELETE");
  });
});

describe("axiosPack — instance built in another file", () => {
  it("discovers a client boundary through an instance imported from another file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      import axios from "axios";
      export const api = axios.create({ baseURL: "/api" });
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { api } from "./client";

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }

      export async function deleteUser(id: string) {
        await api.delete(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    const get = summaries.find((s) => s.identity.name === "getUser");
    expect(get?.kind).toBe("client");
    expect(get?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });

    const del = summaries.find((s) => s.identity.name === "deleteUser");
    expect(del?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "DELETE", path: "/users/{id}" },
      recognition: "axios",
    });
  });

  it("resolves a wrapper method whose body forwards to an instance built in another file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      import axios from "axios";
      export const api = axios.create({ baseURL: "/api" });
    `,
    );
    project.createSourceFile(
      "wrapper.ts",
      `
      import { api } from "./client";

      export class Api {
        static get(route: string) {
          return api.get(route);
        }
      }
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { Api } from "./wrapper";

      export async function getUser(id: string) {
        return Api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    // The wrapper method itself. Its path is a forwarded parameter, and
    // one caller passes a literal, so the parameter is that literal.
    // Two callers passing different paths would leave it unresolved.
    const wrapper = summaries.find((s) => s.identity.name === "get");
    expect(wrapper).toBeDefined();
    const wrapperSem = wrapper?.identity.boundaryBinding?.semantics;
    expect(wrapperSem?.name === "rest" ? wrapperSem.path : "unset").toBe(
      "/users/{id}",
    );

    // The caller, synthesised by wrapper expansion from its own
    // literal-path call site.
    const caller = summaries.find((s) => s.identity.name === "getUser");
    expect(caller).toBeDefined();
    expect(caller?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
    expect(
      (caller?.metadata as { derivedFromWrapper?: { name: string } })
        ?.derivedFromWrapper?.name,
    ).toBe("get");
  });

  it("produces nothing for a call on a subject that never resolves to a known instance", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      function someOtherFactory() {
        return { get: (url: string) => Promise.resolve(url) };
      }
      export const notAnAxiosInstance = someOtherFactory();
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { notAnAxiosInstance } from "./client";

      export async function getUser(id: string) {
        return notAnAxiosInstance.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    expect(
      summaries.find((s) => s.identity.name === "getUser"),
    ).toBeUndefined();
  });

  it("honors a configured factory naming a project's own instance-building function", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "apiClient.ts",
      `
      import axios from "axios";
      export function createApiClient() {
        return axios.create({ baseURL: "/api" });
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { createApiClient } from "./apiClient";
      export const api = createApiClient();
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { api } from "./client";

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [
        axiosPack({
          factories: [{ module: "./apiClient", export: "createApiClient" }],
        }),
      ],
    });
    const summaries = await adapter.extractAll();

    const summary = summaries.find((s) => s.identity.name === "getUser");
    expect(summary).toBeDefined();
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
  });

  it("does not recognize a configured factory when the pack isn't told about it", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "apiClient.ts",
      `
      declare function externalFactory(): unknown;
      export function createApiClient() {
        return externalFactory();
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { createApiClient } from "./apiClient";
      export const api = createApiClient();
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { api } from "./client";

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    expect(
      summaries.find((s) => s.identity.name === "getUser"),
    ).toBeUndefined();
  });

  it("resolves an instance whose creating file aliases the axios import", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      import ax from "axios";
      export const api = ax.create({ baseURL: "/api" });
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { api } from "./client";

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();

    const summary = summaries.find((s) => s.identity.name === "getUser");
    expect(summary).toBeDefined();
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
  });

  it("honors a configured factory whose module path differs from how a nested consumer writes it", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "apiClient.ts",
      `
      import axios from "axios";
      export function createApiClient() {
        return axios.create({ baseURL: "/api" });
      }
    `,
    );
    project.createSourceFile(
      "nested/dir/consumer.ts",
      `
      import { createApiClient } from "../../apiClient";

      const api = createApiClient();

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [
        axiosPack({
          factories: [{ module: "./apiClient", export: "createApiClient" }],
        }),
      ],
    });
    const summaries = await adapter.extractAll();

    const summary = summaries.find((s) => s.identity.name === "getUser");
    expect(summary).toBeDefined();
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
  });

  it("still gates a bare-specifier factory by its literal import text", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import { createApiClient } from "@acme/api-client";

      const api = createApiClient();

      export async function getUser(id: string) {
        return api.get(\`/users/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [
        axiosPack({
          factories: [
            { module: "@acme/api-client", export: "createApiClient" },
          ],
        }),
      ],
    });
    const summaries = await adapter.extractAll();

    const summary = summaries.find((s) => s.identity.name === "getUser");
    expect(summary).toBeDefined();
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
  });
});

describe("axiosPack — a call whose receiver is itself a call", () => {
  it("matches a method called on what a guarded cached-instance wrapper returns", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios, { AxiosInstance } from "axios";

      let cached: AxiosInstance | null = null;
      function client() {
        if (!cached) {
          cached = axios.create({ baseURL: "/api" });
        }
        return cached;
      }

      export async function getUser() {
        return client().get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("matches a method called on what a wrapper returns fresh from axios.create()", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios from "axios";

      function client() {
        return axios.create({ baseURL: "/api" });
      }

      export async function getUser() {
        return client().get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("matches a call through a wrapper imported from another file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      import axios, { AxiosInstance } from "axios";

      let cached: AxiosInstance | null = null;
      export function client() {
        if (!cached) {
          cached = axios.create({ baseURL: "/api" });
        }
        return cached;
      }
    `,
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { client } from "./client";

      export async function getUser() {
        return client().get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("matches a call on a name a function binds the wrapper's result to", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios, { AxiosInstance } from "axios";

      let cached: AxiosInstance | null = null;
      function client() {
        if (!cached) {
          cached = axios.create({ baseURL: "/api" });
        }
        return cached;
      }

      export async function getUser() {
        const c = client();
        return c.get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("matches a call on a module-level name bound to the wrapper's result", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import axios, { AxiosInstance } from "axios";

      let cached: AxiosInstance | null = null;
      function client() {
        if (!cached) {
          cached = axios.create({ baseURL: "/api" });
        }
        return cached;
      }

      const c = client();

      export async function getUser() {
        return c.get("/users/1");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });
});

describe("axiosPack fixtures", () => {
  const fixturesDir = path.resolve(__dirname, "../../../../fixtures/axios");

  // One extraction for the whole file. Every test below asks a
  // different question of the same run, and building the project per
  // test put each one within reach of vitest's timeout.
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    const project = createFixtureProject(fixturesDir, "*.ts");
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosPack()],
    });
    summaries = await adapter.extractAll();
  }, 90_000);

  it("summarizes a call on the instance a named import brings in", () => {
    const summary = summaries.find((s) => s.identity.name === "getUser");
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "axios",
    });
  });

  it("summarizes a call on the instance a default import brings in", () => {
    const summary = summaries.find((s) => s.identity.name === "listOrders");
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/orders" },
      recognition: "axios",
    });
  });

  it("summarizes a call on the instance an aliased import brings in", () => {
    const summary = summaries.find((s) => s.identity.name === "createUser");
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "POST", path: "/users" },
      recognition: "axios",
    });
  });

  it("summarizes a call on the instance a barrel re-export brings in", () => {
    const summary = summaries.find((s) => s.identity.name === "getReport");
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/reports/weekly" },
      recognition: "axios",
    });
  });

  it("keeps the call-site path, and only that, for a dynamic-base instance", () => {
    const summary = summaries.find((s) => s.identity.name === "getSettings");
    // The base URL is a runtime value. The call site is still a
    // boundary, and its path is the one written at the call site; the
    // base never becomes part of the summary, the same as a literal
    // base on the same-file shape.
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/settings" },
      recognition: "axios",
    });
  });
});
