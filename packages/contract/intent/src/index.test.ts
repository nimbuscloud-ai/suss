// index.test.ts — @suss/contract-intent unit tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  intentSpecDirectoryToSummaries,
  intentSpecFileToSummaries,
  intentSpecToSummaries,
} from "./index.js";

const minimalSpec = {
  kind: "boundary",
  name: "users-lookup",
  boundary: {
    transport: "http",
    semantics: "rest",
    method: "GET",
    path: "/users/:id",
  },
  purpose: "Look up a user by id.",
  audience: "web-client",
  transitions: [
    {
      id: "not-found",
      when: "user not found",
      output: {
        status: 404,
        body: { properties: { error: { type: "string" } } },
      },
    },
    {
      id: "found",
      when: "user exists",
      output: {
        status: 200,
        body: {
          properties: {
            id: { type: "string" },
            fullName: { type: "string" },
          },
        },
      },
    },
  ],
};

const minimalPrd = {
  kind: "prd",
  title: "User profile lookup",
  purpose: "Fetch a user's profile information by id.",
  audience: "web-client",
  scenarios: [
    {
      title: "Successful lookup",
      when: "A request comes in with a known user id",
      expect: "users-lookup.found",
    },
    {
      title: "Missing user",
      when: "The id doesn't match any record",
      expect: "users-lookup.not-found",
    },
  ],
};

describe("intentSpecToSummaries — in-memory parse + transform", () => {
  it("produces one BehavioralSummary per intent spec", () => {
    const summaries = intentSpecToSummaries(minimalSpec);
    expect(summaries).toHaveLength(1);
  });

  it("encodes the REST boundary via boundaryBinding", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "intent",
    });
  });

  it("carries name, purpose, and audience under metadata.intent", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.metadata?.intent).toEqual({
      name: "users-lookup",
      purpose: "Look up a user by id.",
      audience: "web-client",
    });
  });

  it("marks confidence as declared at high level", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.confidence).toEqual({
      source: "declared",
      level: "high",
    });
  });

  it("turns each transition into a response with literal status + record body", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    const statuses = summary.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statuses).toEqual([404, 200]);
    const lastBody = summary.transitions[1].output;
    expect(lastBody.type).toBe("response");
    if (lastBody.type !== "response") {
      return;
    }
    expect(lastBody.body).toEqual({
      type: "record",
      properties: {
        id: { type: "text" },
        fullName: { type: "text" },
      },
    });
  });

  it("treats the last transition as default; earlier ones carry their `when` as an opaque predicate", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.transitions[0].isDefault).toBe(false);
    expect(summary.transitions[0].conditions).toEqual([
      {
        type: "opaque",
        sourceText: "user not found",
        reason: "complexExpression",
      },
    ]);
    expect(summary.transitions[1].isDefault).toBe(true);
    expect(summary.transitions[1].conditions).toEqual([]);
  });

  it("preserves the author-declared outcome id on each transition", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.transitions.map((t) => t.id)).toEqual([
      "not-found",
      "found",
    ]);
  });

  it("throws on a spec missing purpose", () => {
    const bad = { ...minimalSpec, purpose: "" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on a spec missing audience", () => {
    const bad = { ...minimalSpec, audience: "" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on a spec missing name", () => {
    const bad = { ...minimalSpec, name: "" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on a transition missing its id", () => {
    const bad = {
      ...minimalSpec,
      transitions: [{ when: "x", output: { status: 200 } }],
    };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on an out-of-range status code", () => {
    const bad = {
      ...minimalSpec,
      transitions: [
        { id: "x", when: "x", output: { status: 999 } },
        { id: "y", when: "y", output: { status: 200 } },
      ],
    };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });
});

describe("intentSpecToSummaries — PRD shape (kind: prd)", () => {
  it("produces a library-kind summary with metadata.prd", () => {
    const summaries = intentSpecToSummaries(minimalPrd);
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary.kind).toBe("library");
    expect(summary.identity.boundaryBinding).toBeNull();
    expect(summary.identity.name).toBe("User profile lookup");
    expect(summary.metadata?.prd).toEqual({
      title: "User profile lookup",
      purpose: "Fetch a user's profile information by id.",
      audience: "web-client",
      scenarios: [
        {
          title: "Successful lookup",
          when: "A request comes in with a known user id",
          expect: ["users-lookup.found"],
        },
        {
          title: "Missing user",
          when: "The id doesn't match any record",
          expect: ["users-lookup.not-found"],
        },
      ],
    });
  });

  it("normalises a scalar `expect` into a single-element array", () => {
    const summaries = intentSpecToSummaries(minimalPrd);
    const scenarios = (
      summaries[0].metadata?.prd as { scenarios: Array<{ expect: string[] }> }
    ).scenarios;
    for (const s of scenarios) {
      expect(Array.isArray(s.expect)).toBe(true);
    }
  });

  it("accepts a multi-outcome `expect` array", () => {
    const prd = {
      ...minimalPrd,
      scenarios: [
        {
          title: "Composite outcome",
          when: "Order is placed",
          expect: ["order-intake.acknowledged", "order-intake.queued"],
        },
      ],
    };
    const summaries = intentSpecToSummaries(prd);
    const scenarios = (
      summaries[0].metadata?.prd as { scenarios: Array<{ expect: string[] }> }
    ).scenarios;
    expect(scenarios[0].expect).toEqual([
      "order-intake.acknowledged",
      "order-intake.queued",
    ]);
  });

  it("throws on a PRD with no scenarios", () => {
    const bad = { ...minimalPrd, scenarios: [] };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on an unknown top-level kind", () => {
    const bad = { ...minimalSpec, kind: "concept" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });
});

describe("intentSpecFileToSummaries — file loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intent-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loads a YAML boundary intent by extension", () => {
    const file = path.join(tmpDir, "users.intent.yaml");
    fs.writeFileSync(
      file,
      [
        "kind: boundary",
        "name: users-lookup",
        "boundary:",
        "  transport: http",
        "  semantics: rest",
        "  method: GET",
        "  path: /users/:id",
        "purpose: Look up a user by id.",
        "audience: web-client",
        "transitions:",
        "  - id: found",
        "    when: user exists",
        "    output:",
        "      status: 200",
        "      body:",
        "        properties:",
        "          id: { type: string }",
        "          fullName: { type: string }",
        "",
      ].join("\n"),
    );
    const summaries = intentSpecFileToSummaries(file);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("GET /users/:id");
  });

  it("loads a JSON boundary intent via the .json extension", () => {
    const file = path.join(tmpDir, "users.intent.json");
    fs.writeFileSync(file, JSON.stringify(minimalSpec));
    const summaries = intentSpecFileToSummaries(file);
    expect(summaries).toHaveLength(1);
  });

  it("loads a PRD file via the .prd.yaml extension", () => {
    // The YAML parser accepts JSON syntax, so writing the JSON form
    // exercises the same .yaml dispatch path without a YAML dependency
    // here.
    const file = path.join(tmpDir, "users.prd.yaml");
    fs.writeFileSync(file, JSON.stringify(minimalPrd));
    const summaries = intentSpecFileToSummaries(file);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("library");
    expect(summaries[0].metadata?.prd).toBeDefined();
  });

  it("throws a useful error when the file is missing", () => {
    expect(() =>
      intentSpecFileToSummaries(path.join(tmpDir, "no-such.intent.yaml")),
    ).toThrow(/not found/);
  });

  it("throws when the file isn't an object at the top level", () => {
    const file = path.join(tmpDir, "scalar.intent.yaml");
    fs.writeFileSync(file, "42\n");
    expect(() => intentSpecFileToSummaries(file)).toThrow(/not an object/);
  });

  it("throws when YAML is syntactically malformed", () => {
    const file = path.join(tmpDir, "bad.intent.yaml");
    fs.writeFileSync(file, "boundary: [unterminated\n");
    expect(() => intentSpecFileToSummaries(file)).toThrow(/failed to parse/);
  });
});

describe("intentSpecDirectoryToSummaries — directory walk", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intent-dir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("walks recursively and returns one summary per *.intent.* or *.prd.* file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "users.intent.json"),
      JSON.stringify(minimalSpec),
    );
    fs.writeFileSync(
      path.join(tmpDir, "users.prd.json"),
      JSON.stringify(minimalPrd),
    );
    const subdir = path.join(tmpDir, "billing");
    fs.mkdirSync(subdir);
    fs.writeFileSync(
      path.join(subdir, "invoices.intent.json"),
      JSON.stringify({
        ...minimalSpec,
        name: "invoices-lookup",
        boundary: { ...minimalSpec.boundary, path: "/invoices/:id" },
      }),
    );
    // A non-intent file should be ignored.
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# notes");

    const summaries = intentSpecDirectoryToSummaries(tmpDir);
    expect(summaries).toHaveLength(3);
    // The two boundary intents (users + invoices) plus the PRD.
    const restPaths = summaries
      .map((s) => {
        const binding = s.identity.boundaryBinding;
        if (binding === null || binding.semantics.name !== "rest") {
          return null;
        }
        return binding.semantics.path;
      })
      .filter((p): p is string => p !== null)
      .sort();
    expect(restPaths).toEqual(["/invoices/:id", "/users/:id"]);
    const prdSummaries = summaries.filter((s) => s.metadata?.prd !== undefined);
    expect(prdSummaries).toHaveLength(1);
  });

  it("throws when the directory doesn't exist", () => {
    expect(() =>
      intentSpecDirectoryToSummaries(path.join(tmpDir, "no-such")),
    ).toThrow(/not found/);
  });

  it("throws when the path is a file, not a directory", () => {
    const file = path.join(tmpDir, "not-a-dir.intent.yaml");
    fs.writeFileSync(file, "boundary: {}\n");
    expect(() => intentSpecDirectoryToSummaries(file)).toThrow(
      /not a directory/,
    );
  });
});
