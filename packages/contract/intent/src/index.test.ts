// index.test.ts — @suss/contract-intent unit tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadIntentDirectory, loadIntentDoc, loadIntentFile } from "./index.js";

import type { BoundaryIntentSummary, PrdSummary } from "./index.js";

const boundarySpec = {
  kind: "boundary",
  name: "users-lookup",
  purpose: "Look up a user by id.",
  audience: "web-client",
  boundary: {
    transport: "http",
    semantics: "rest",
    method: "GET",
    path: "/users/:id",
  },
  transitions: [
    {
      id: "not-found",
      when: "user not found",
      response: {
        status: 404,
        body: { properties: { error: { type: "string" } } },
      },
    },
    {
      id: "found",
      when: "user exists",
      response: {
        status: 200,
        body: {
          properties: { id: { type: "string" }, fullName: { type: "string" } },
        },
      },
    },
  ],
};

const prdSpec = {
  kind: "prd",
  title: "User profile lookup",
  purpose: "A signed-in user can view any profile by id.",
  audience: "web-client",
  scenarios: [
    {
      when: "the id resolves to a user",
      expect: "the profile is returned",
      link: "users-lookup.found",
    },
    { when: "the id is unknown", expect: "the caller is told it wasn't found" },
  ],
};

describe("loadIntentDoc", () => {
  it("normalises a boundary spec into a BoundaryIntentSummary", () => {
    const summary = loadIntentDoc(boundarySpec) as BoundaryIntentSummary;
    expect(summary.kind).toBe("boundary");
    expect(summary.boundary.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/users/:id",
    });
    expect(summary.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["not-found", 404],
      ["found", 200],
    ]);
  });

  it("normalises a PRD spec into a PrdSummary, leaving an unlinked scenario empty", () => {
    const summary = loadIntentDoc(prdSpec) as PrdSummary;
    expect(summary.kind).toBe("prd");
    expect(summary.scenarios.map((s) => s.link)).toEqual([
      ["users-lookup.found"],
      [],
    ]);
  });

  it("throws on a malformed doc", () => {
    expect(() => loadIntentDoc({ kind: "boundary" })).toThrow();
  });
});

describe("loadIntentFile / loadIntentDirectory", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intent-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("reads a YAML intent file", () => {
    const file = path.join(tmpDir, "users.intent.yaml");
    fs.writeFileSync(file, YAML_BOUNDARY);
    const summary = loadIntentFile(file) as BoundaryIntentSummary;
    expect(summary.name).toBe("users-lookup");
    expect(summary.outcomes).toHaveLength(2);
  });

  it("reads a JSON intent file", () => {
    const file = path.join(tmpDir, "users.intent.json");
    fs.writeFileSync(file, JSON.stringify(boundarySpec));
    expect(loadIntentFile(file).kind).toBe("boundary");
  });

  it("throws when the file does not exist", () => {
    expect(() => loadIntentFile(path.join(tmpDir, "nope.intent.yaml"))).toThrow(
      /not found/,
    );
  });

  it("throws with the file path when YAML is malformed", () => {
    const file = path.join(tmpDir, "bad.intent.yaml");
    fs.writeFileSync(file, "kind: boundary\n  bad: : :");
    expect(() => loadIntentFile(file)).toThrow(/failed to parse/);
  });

  it("walks a directory recursively for *.intent and *.prd files", () => {
    fs.writeFileSync(path.join(tmpDir, "users.intent.yaml"), YAML_BOUNDARY);
    const nested = path.join(tmpDir, "product");
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(nested, "lookup.prd.json"),
      JSON.stringify(prdSpec),
    );
    fs.writeFileSync(path.join(tmpDir, "ignore.txt"), "not an intent file");
    const summaries = loadIntentDirectory(tmpDir);
    expect(summaries.map((s) => s.kind).sort()).toEqual(["boundary", "prd"]);
  });

  it("throws when the directory does not exist", () => {
    expect(() => loadIntentDirectory(path.join(tmpDir, "nope"))).toThrow(
      /not found/,
    );
  });
});

const YAML_BOUNDARY = `
kind: boundary
name: users-lookup
purpose: Look up a user by id.
audience: web-client
boundary:
  transport: http
  semantics: rest
  method: GET
  path: /users/:id
transitions:
  - id: not-found
    when: user not found
    response:
      status: 404
      body:
        properties:
          error: { type: string }
  - id: found
    when: user exists
    response:
      status: 200
      body:
        properties:
          id: { type: string }
          fullName: { type: string }
`;
