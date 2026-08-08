// pairFrontendBackendIntegration.test.ts: the docs/tutorial/pair-frontend-backend
// flow as an end-to-end check. An Express provider and a fetch consumer
// share no types; the only joining artifact is the OpenAPI document. The
// consumer reads the body in `.then` chain form
// (`fetch(url).then(res => res.json()).then(data => data.name)`), the case
// the adapter-ecmascript-spec proposal's field-flow remainder targets.
// Two drift bugs must surface from source alone:
//
//   1. the consumer has no branch for the provider's 404 status;
//   2. the consumer reads `.name`, but the provider (and contract) 200
//      body has `{ id, fullName }`.
//
// Before consumer field-access flow followed `.then` callback parameters,
// the second finding never fired from a `.then`-style consumer because the
// parsed body's shape never reached `collectClientFieldAccesses`.
//
// The consumer is a data-loader that returns the parsed value. The
// tutorial's inline `useEffect(() => { fetch(...).then(...) })` form, whose
// callback returns nothing, produces no consumer transition to record the
// field access: terminal synthesis for void callbacks is a separate gap,
// orthogonal to the field-flow this test exercises.

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { webFetchPack } from "@suss/client-web";
import { type OpenApiSpec, openApiToSummaries } from "@suss/contract-openapi";
import { expressFramework } from "@suss/framework-express";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

const BACKEND = `
import express from "express";

interface User {
  id: string;
  fullName: string;
}

const users: Record<string, User> = {
  "1": { id: "1", fullName: "Ada Lovelace" },
};

const app = express();

app.get("/users/:id", (req, res) => {
  const user = users[req.params.id];
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(user);
});
`;

// Ambient global declarations so `fetch(...)` is `Promise`-typed in the
// in-memory project (the strict `.then` binding gate needs the checker to
// see a `Promise<T>` receiver). Mirrors lib.dom without loading it.
const GLOBALS = `
interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<any>;
}
declare function fetch(input: string, init?: unknown): Promise<JsonResponse>;
`;

const FRONTEND = `
export function loadUser(id: string) {
  return fetch(\`/users/\${id}\`)
    .then((res) => res.json())
    .then((data) => data.name);
}
`;

const OPENAPI: OpenApiSpec = {
  openapi: "3.1.0",
  info: { title: "Users API", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "User found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "fullName"],
                  properties: {
                    id: { type: "string" },
                    fullName: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "User not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["error"],
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function inMemoryProject(): Project {
  return createTestProject();
}

async function extractAll(): Promise<BehavioralSummary[]> {
  const backendProject = inMemoryProject();
  backendProject.createSourceFile("backend/server.ts", BACKEND);
  const backend = await createTypeScriptAdapter({
    project: backendProject,
    frameworks: [expressFramework()],
  }).extractAll();

  const frontendProject = inMemoryProject();
  frontendProject.createSourceFile("frontend/globals.d.ts", GLOBALS);
  frontendProject.createSourceFile("frontend/loader.ts", FRONTEND);
  const frontend = await createTypeScriptAdapter({
    project: frontendProject,
    frameworks: [webFetchPack()],
  }).extractAll();

  const contract = openApiToSummaries(OPENAPI);

  return [...backend, ...frontend, ...contract];
}

function providerBodyMismatch(findings: Finding[]): Finding | undefined {
  return findings.find(
    (f) =>
      f.kind === "unhandledProviderCase" &&
      f.description.includes("the provider never sends"),
  );
}

describe("pair frontend + backend (.then consumer)", () => {
  it("extracts a consumer that reads body fields through a .then chain", async () => {
    const summaries = await extractAll();
    const consumer = summaries.find((s) => s.kind === "client");
    expect(consumer).toBeDefined();

    // The parsed body's `.name` read reached expectedInput via the `.then`
    // chain, nested under the `json` body accessor.
    const withInput = consumer?.transitions.find(
      (t) => t.expectedInput?.type === "record",
    );
    expect(withInput).toBeDefined();
    const input = withInput?.expectedInput;
    if (input?.type === "record" && input.properties.json?.type === "record") {
      expect(input.properties.json.properties).toHaveProperty("name");
    } else {
      throw new Error("expected json.name in the consumer's expectedInput");
    }
  });

  it("pairs the express provider with the fetch consumer", async () => {
    const summaries = await extractAll();
    const { pairs } = checkAll(summaries);
    // Provider/consumer pair on (GET, /users/:id ~ /users/{id}); the
    // OpenAPI contract pairs with the consumer on the same boundary.
    expect(pairs.length).toBeGreaterThanOrEqual(1);
  });

  it("flags the unhandled 404 and the .name field mismatch", async () => {
    const summaries = await extractAll();
    const { findings } = checkAll(summaries);

    // 1. Consumer has no branch handling the provider's 404.
    const unhandled404 = findings.filter(
      (f) =>
        f.kind === "unhandledProviderCase" && f.description.includes("404"),
    );
    expect(unhandled404.length).toBeGreaterThanOrEqual(1);

    // 2. Consumer reads `.name`; provider 200 body is `{ id, fullName }`.
    //    This finding depends on the `.then`-chain field flow.
    expect(providerBodyMismatch(findings)).toBeDefined();
  });
});
