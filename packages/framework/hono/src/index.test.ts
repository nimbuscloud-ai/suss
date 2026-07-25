import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { honoFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/hono/api.ts",
);

describe("honoFramework", () => {
  it("registers routes off a constructed app", () => {
    const pack = honoFramework();
    expect(pack.name).toBe("hono");
    expect(pack.protocol).toBe("http");
    // `new Hono()` and `new OpenAPIHono()`, times six verbs.
    expect(pack.discovery).toHaveLength(2);
    expect(pack.discovery[0]?.requiresImport).toEqual(["hono"]);
  });

  it("reads the context at parameter 0, not a response object at 1", () => {
    // Express hands the handler a response object as its second
    // parameter; Hono hands one context as its first and the handler
    // returns from it. Reading position 1 here would find nothing.
    const responses = honoFramework().terminals.filter(
      (t) => t.match.type === "parameterMethodCall",
    );
    expect(responses.length).toBeGreaterThan(0);
    for (const terminal of responses) {
      expect(
        terminal.match.type === "parameterMethodCall"
          ? terminal.match.parameterPosition
          : null,
      ).toBe(0);
    }
  });
});

describe("honoFramework — extraction", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    const adapter = createTypeScriptAdapter({
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    adapter.project.addSourceFileAtPath(FIXTURE);
    summaries = await adapter.extractAll();
  });

  function boundary(method: string, routePath: string) {
    return summaries.find((s) => {
      const semantics = s.identity.boundaryBinding?.semantics;
      return (
        semantics?.name === "rest" &&
        semantics.method === method &&
        semantics.path === routePath
      );
    });
  }

  function statuses(summary: BehavioralSummary | undefined): unknown[] {
    return (summary?.transitions ?? [])
      .map((t) => (t.output.type === "response" ? t.output.statusCode : null))
      .map((code) => (code?.type === "literal" ? code.value : code?.type))
      .sort();
  }

  it("finds every registered route", () => {
    expect(boundary("GET", "/users/:id")).toBeDefined();
    expect(boundary("POST", "/users")).toBeDefined();
    expect(boundary("GET", "/legacy/:id")).toBeDefined();
  });

  it("reads each guard's status from the second argument", () => {
    expect(statuses(boundary("GET", "/users/:id"))).toEqual([200, 404, 410]);
  });

  it("defaults to 200 when the handler passes no status", () => {
    const ok = boundary("GET", "/users/:id")?.transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );
    const body = ok?.output.type === "response" ? ok.output.body : null;
    expect(
      Object.keys((body as { properties?: object })?.properties ?? {}),
    ).toEqual(expect.arrayContaining(["id", "name"]));
  });

  it("reads a text response and its status", () => {
    expect(statuses(boundary("POST", "/users"))).toEqual([201, 400]);
  });

  it("gives a redirect Hono's default status", () => {
    expect(statuses(boundary("GET", "/legacy/:id"))).toEqual([302]);
  });
});
