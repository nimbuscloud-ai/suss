import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { axiosRuntime } from "./index.js";

describe("axiosRuntime — pack shape", () => {
  it("exposes a discovery pattern per HTTP verb", () => {
    const pack = axiosRuntime();
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

  it("declares response semantics for axios's AxiosResponse shape", () => {
    const pack = axiosRuntime();
    const semantics = pack.responseSemantics ?? [];
    const data = semantics.find((s) => s.name === "data");
    expect(data?.semantics.type).toBe("body");
    const status = semantics.find((s) => s.name === "status");
    expect(status?.semantics.type).toBe("statusCode");
  });
});

describe("axiosRuntime — integration", () => {
  it("discovers axios.get(url) and extracts GET + path from arg 0", () => {
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
      frameworks: [axiosRuntime()],
    });
    const summaries = adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("client");
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].identity.boundaryBinding).toEqual({
      protocol: "http",
      method: "GET",
      path: "/users/1",
      framework: "axios",
    });
  });

  it("distinguishes verbs by the called method name", () => {
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
      frameworks: [axiosRuntime()],
    });
    const summaries = adapter.extractAll();

    const post = summaries.find((s) => s.identity.name === "createUser");
    expect(post?.identity.boundaryBinding?.method).toBe("POST");
    expect(post?.identity.boundaryBinding?.path).toBe("/users");

    const del = summaries.find((s) => s.identity.name === "deleteUser");
    expect(del?.identity.boundaryBinding?.method).toBe("DELETE");
    expect(del?.identity.boundaryBinding?.path).toBe("/users/1");
  });

  it("produces transitions for branches in the consumer function", () => {
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
      frameworks: [axiosRuntime()],
    });
    const summaries = adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].transitions.length).toBeGreaterThanOrEqual(2);
  });

  it("does not match calls on instances created via axios.create()", () => {
    // v0 limitation: `const api = axios.create(); api.get(...)` is not
    // currently discovered. This test pins the limitation so we'll notice
    // when we lift it.
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
      frameworks: [axiosRuntime()],
    });
    const summaries = adapter.extractAll();
    // The api.get(...) call site is not discovered; only direct axios.<verb>
    // calls are matched by v0.
    expect(summaries).toHaveLength(0);
  });
});
