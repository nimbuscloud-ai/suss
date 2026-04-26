import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { axiosPack } from "./index.js";

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
});

describe("axiosPack — integration", () => {
  it("discovers axios.get(url) and extracts GET + path from arg 0", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/1" },
      recognition: "axios",
    });
  });

  it("distinguishes verbs by the called method name", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
