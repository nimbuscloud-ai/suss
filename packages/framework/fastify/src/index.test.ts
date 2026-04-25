import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { fastifyFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — adds fixtures/fastify/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/fastify");

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
    },
  });
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [fastifyFramework()],
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Structural sanity checks
// ---------------------------------------------------------------------------

describe("fastifyFramework — pack shape", () => {
  it("exposes the expected discovery, terminals, and inputMapping keys", () => {
    const pack = fastifyFramework();
    expect(pack.name).toBe("fastify");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    // Two discovery patterns — default-import and named-import variants
    expect(pack.discovery).toHaveLength(2);
    expect(pack.contractReading).toBeUndefined();
    expect(pack.inputMapping.type).toBe("positionalParams");
  });

  it("registers all standard HTTP method verbs", () => {
    const pack = fastifyFramework();
    for (const discovery of pack.discovery) {
      expect(discovery.match.type).toBe("registrationCall");
      if (discovery.match.type !== "registrationCall") {
        continue;
      }
      expect(discovery.match.registrationChain).toEqual([
        ".get",
        ".post",
        ".put",
        ".delete",
        ".patch",
        ".head",
        ".options",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the fastify fixture
// ---------------------------------------------------------------------------

describe("fastifyFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers every app.<method> handler in the fixture", () => {
    expect(summaries).toHaveLength(5);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.name).toBe("get");
      expect(s.identity.boundaryBinding).toEqual({
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "fastify",
      });
    }
  });

  it("maps positional params (request, reply) to framework roles", () => {
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();
    const roles = main?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(roles).toEqual(["request", "reply"]);
  });

  it("assembles the /users/:id guard chain into four response transitions", () => {
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();

    // Branch order:
    //   1. !id                       → reply.code(400).send(...)   → 400
    //   2. !user                     → reply.code(404).send(...)   → 404
    //   3. user.role === "admin"     → reply.send(...)             → 200 (default)
    //   4. default                   → reply.send(user)            → 200 (default)
    const statusCodes = main?.transitions.map((t) =>
      t.output.type === "response" ? t.output.statusCode : "not-response",
    );
    expect(statusCodes).toEqual([
      { type: "literal", value: 400 },
      { type: "literal", value: 404 },
      { type: "literal", value: 200 },
      { type: "literal", value: 200 },
    ]);

    expect(main?.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    if (!main) {
      throw new Error("main summary missing");
    }
    for (const t of main.transitions) {
      expect(t.output.type).toBe("response");
    }
  });

  it("redirect(url) → 1-arg form falls back to default 302", () => {
    const oneArg = summaries.find((s) => {
      if (s.transitions.length !== 1) {
        return false;
      }
      const out = s.transitions[0].output;
      return (
        out.type === "response" &&
        out.statusCode?.type === "literal" &&
        out.statusCode.value === 302
      );
    });
    expect(oneArg).toBeDefined();
  });

  it("redirect(N, url) → 2-arg form extracts the status code from arg 0", () => {
    const twoArg = summaries
      .filter((s) => s.transitions.length === 1)
      .find((s) => {
        const out = s.transitions[0].output;
        return (
          out.type === "response" &&
          out.statusCode?.type === "literal" &&
          out.statusCode.value === 301
        );
      });
    expect(twoArg).toBeDefined();
  });

  it("has no gaps when there is no contract", () => {
    for (const s of summaries) {
      expect(s.gaps).toEqual([]);
    }
  });

  it("matches bare returns as 200 responses without double-firing on `return reply.send(...)`", () => {
    // /me has three transitions: 401 (early return reply.code(401).send(...)),
    // 404 (early return reply.code(404).send(...)), and a default 200 from
    // bare `return user`. The two `return reply.code(...).send(...)` paths
    // must each produce exactly ONE response transition — the inner
    // parameterMethodCall — not also a second from the wrapping return.
    const meHandler = summaries.find((s) => s.transitions.length === 3);
    expect(meHandler).toBeDefined();
    if (!meHandler) {
      throw new Error("/me handler not found");
    }
    const statuses = meHandler.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statuses.sort()).toEqual([200, 401, 404]);
    // The 200 default-branch transition should carry a body shape derived
    // from the returned identifier (`user`).
    const defaultTxn = meHandler.transitions.find((t) => t.isDefault);
    expect(defaultTxn?.output.type).toBe("response");
    if (defaultTxn?.output.type !== "response") {
      return;
    }
    expect(defaultTxn.output.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(defaultTxn.output.body).not.toBeNull();
  });

  it("matches bare object-literal returns and surfaces the literal shape", () => {
    // /defaults returns an inline `{ theme, locale }`. The returnStatement
    // match should fire and the body should reflect the object literal.
    const defaultsHandler = summaries.find((s) => {
      const t = s.transitions[0];
      if (s.transitions.length !== 1 || t.output.type !== "response") {
        return false;
      }
      const body = t.output.body;
      if (body === null || body.type !== "record") {
        return false;
      }
      return "theme" in body.properties && "locale" in body.properties;
    });
    expect(defaultsHandler).toBeDefined();
  });
});
