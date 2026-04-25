import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { findResponseVariable } from "./field-accesses.js";

import type { PatternPack } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Helper: create a project and get the first call expression
// ---------------------------------------------------------------------------

function createProject() {
  return new Project({ useInMemoryFileSystem: true });
}

function getFirstCallExpression(project: Project, fileName: string) {
  const file = project.getSourceFileOrThrow(fileName);
  let result: Node | undefined;
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node) && result === undefined) {
      const text = node.getExpression().getText();
      if (text === "fetch" || text.includes(".getUser")) {
        result = node;
      }
    }
  });
  if (result === undefined || !Node.isCallExpression(result)) {
    throw new Error("No matching call expression found");
  }
  return result;
}

// ---------------------------------------------------------------------------
// findResponseVariable
// ---------------------------------------------------------------------------

describe("findResponseVariable", () => {
  it("finds variable from const res = await fetch(...)", async () => {
    const project = createProject();
    project.createSourceFile(
      "test.ts",
      `
      async function f() {
        const res = await fetch("/api");
        return res.json();
      }
    `,
    );
    const call = getFirstCallExpression(project, "test.ts");
    expect(findResponseVariable(call)).toBe("res");
  });

  it("finds variable from const result = await client.getUser(...)", async () => {
    const project = createProject();
    project.createSourceFile(
      "test.ts",
      `
      async function f() {
        const result = await (null as any).getUser({});
        return result.body;
      }
    `,
    );
    const call = getFirstCallExpression(project, "test.ts");
    expect(findResponseVariable(call)).toBe("result");
  });

  it("returns null for unassigned calls", async () => {
    const project = createProject();
    project.createSourceFile(
      "test.ts",
      `
      async function f() {
        await fetch("/api");
      }
    `,
    );
    const call = getFirstCallExpression(project, "test.ts");
    expect(findResponseVariable(call)).toBeNull();
  });

  it("returns null for destructured assignments via the simple-identifier API", async () => {
    // findResponseVariable is the legacy shape; richer destructuring info is
    // available via findResponseAccessor. Pin the legacy contract here.
    const project = createProject();
    project.createSourceFile(
      "test.ts",
      `
      async function f() {
        const { data } = await fetch("/api");
        return data;
      }
    `,
    );
    const call = getFirstCallExpression(project, "test.ts");
    expect(findResponseVariable(call)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: expectedInput on consumer transitions
// ---------------------------------------------------------------------------

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
        path: { type: "fromArgumentLiteral", position: 0 },
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

describe("expectedInput on client transitions", () => {
  it("populates expectedInput with body fields read after status check", async () => {
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser(id: string) {
        const res = await fetch("/users/" + id);
        if (res.status === 200) {
          const data = res.body;
          return { name: data.name, email: data.email };
        }
        throw new Error("failed");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    // Find the transition in the status === 200 branch
    const transitions = summaries[0].transitions;
    const bodyTransition = transitions.find(
      (t) =>
        t.expectedInput !== undefined &&
        t.expectedInput !== null &&
        t.expectedInput.type === "record",
    );

    // Should have captured body.name and body.email accesses
    expect(bodyTransition).toBeDefined();
    const input1 = bodyTransition?.expectedInput;
    expect(input1?.type).toBe("record");
    if (input1?.type === "record") {
      expect(input1.properties).toHaveProperty("body");
    }
  });

  it("sets expectedInput to null when no response fields are accessed", async () => {
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function ping() {
        const res = await fetch("/health");
        if (res.status !== 200) {
          throw new Error("unhealthy");
        }
        return true;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    // No body field accesses — all transitions should have no expectedInput
    for (const t of summaries[0].transitions) {
      expect(t.expectedInput).toBeUndefined();
    }
  });

  it("captures nested property accesses like result.body.user.name", async () => {
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const res = await fetch("/api/user");
        if (res.status === 200) {
          return res.body.user.name;
        }
        throw new Error("fail");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const withInput = summaries[0].transitions.find(
      (t) => t.expectedInput !== undefined,
    );
    expect(withInput).toBeDefined();
    // Should have body.user.name
    const input = withInput?.expectedInput;
    expect(input?.type).toBe("record");
    if (input?.type === "record") {
      expect(input.properties).toHaveProperty("body");
      const body = input.properties.body;
      expect(body.type).toBe("record");
      if (body.type === "record") {
        expect(body.properties).toHaveProperty("user");
        const user = body.properties.user;
        expect(user.type).toBe("record");
        if (user.type === "record") {
          expect(user.properties).toHaveProperty("name");
        }
      }
    }
  });

  it("tracks fields read via destructured response (axios-style)", async () => {
    // Real axios usage: `const { data, status } = await axios.get(...)`.
    // Status checks become accesses to `status` (resolved to the underlying
    // property), and field reads on `data` become `data.x` chains.
    const axiosLikePack: PatternPack = {
      ...fetchPack,
      name: "axios-like",
      responseSemantics: [
        { name: "data", access: "property", semantics: { type: "body" } },
        {
          name: "status",
          access: "property",
          semantics: { type: "statusCode" },
        },
      ],
    };
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser(id: string) {
        const { data, status } = await fetch("/users/" + id);
        if (status === 404) {
          return null;
        }
        return { name: data.name, email: data.email };
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const withBodyFields = summaries[0].transitions.find(
      (t) =>
        t.expectedInput?.type === "record" &&
        t.expectedInput.properties.data !== undefined,
    );
    expect(withBodyFields).toBeDefined();
    const input = withBodyFields?.expectedInput;
    if (input?.type === "record" && input.properties.data?.type === "record") {
      expect(input.properties.data.properties).toHaveProperty("name");
      expect(input.properties.data.properties).toHaveProperty("email");
    } else {
      throw new Error("expected nested data record with name + email");
    }
    // Status accesses should be filtered as non-body
    if (input?.type === "record") {
      expect(input.properties).not.toHaveProperty("status");
    }
  });

  it("respects renamed destructured bindings (`{ status: code }`)", async () => {
    const axiosLikePack: PatternPack = {
      ...fetchPack,
      name: "axios-like",
      responseSemantics: [
        { name: "data", access: "property", semantics: { type: "body" } },
        {
          name: "status",
          access: "property",
          semantics: { type: "statusCode" },
        },
      ],
    };
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const { data: payload, status: code } = await fetch("/u");
        if (code === 404) return null;
        return payload.id;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();
    const withInput = summaries[0].transitions.find(
      (t) => t.expectedInput?.type === "record",
    );
    expect(withInput).toBeDefined();
    const input = withInput?.expectedInput;
    if (input?.type === "record" && input.properties.data?.type === "record") {
      // Local binding was `payload` but it's recorded against the underlying
      // `data` property — that's what the provider declares.
      expect(input.properties.data.properties).toHaveProperty("id");
    } else {
      throw new Error("expected data record with id");
    }
  });

  it("filters out status/ok/headers accesses", async () => {
    const project = createProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function check() {
        const res = await fetch("/check");
        if (res.ok && res.status === 200) {
          console.log(res.headers);
          return res.body.data;
        }
        throw new Error("fail");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    const withInput = summaries[0].transitions.find(
      (t) => t.expectedInput !== undefined,
    );
    expect(withInput).toBeDefined();
    const input = withInput?.expectedInput;
    expect(input).toBeDefined();
    // Should only have body.data, not status/ok/headers
    expect(input?.type).toBe("record");
    if (input?.type === "record") {
      expect(input.properties).toHaveProperty("body");
      expect(input.properties).not.toHaveProperty("status");
      expect(input.properties).not.toHaveProperty("ok");
      expect(input.properties).not.toHaveProperty("headers");
    }
  });
});
