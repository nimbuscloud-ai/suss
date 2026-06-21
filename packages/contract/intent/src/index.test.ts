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
      when: "user not found",
      output: {
        status: 404,
        body: { properties: { error: { type: "string" } } },
      },
    },
    {
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

  it("carries purpose and audience under metadata.intent", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.metadata?.intent).toEqual({
      purpose: "Look up a user by id.",
      audience: "web-client",
    });
  });

  it("marks confidence as a high-quality specification", () => {
    const [summary] = intentSpecToSummaries(minimalSpec);
    expect(summary.confidence).toEqual({
      source: "specification",
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

  it("throws on a spec missing purpose", () => {
    const bad = { ...minimalSpec, purpose: "" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on a spec missing audience", () => {
    const bad = { ...minimalSpec, audience: "" };
    expect(() => intentSpecToSummaries(bad)).toThrow();
  });

  it("throws on an out-of-range status code", () => {
    const bad = {
      ...minimalSpec,
      transitions: [
        { when: "x", output: { status: 999 } },
        { when: "y", output: { status: 200 } },
      ],
    };
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

  it("loads a YAML spec by extension", () => {
    const file = path.join(tmpDir, "users.intent.yaml");
    fs.writeFileSync(
      file,
      [
        "boundary:",
        "  transport: http",
        "  semantics: rest",
        "  method: GET",
        "  path: /users/:id",
        "purpose: Look up a user by id.",
        "audience: web-client",
        "transitions:",
        "  - when: user exists",
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

  it("loads a JSON spec via the .json extension", () => {
    const file = path.join(tmpDir, "users.intent.json");
    fs.writeFileSync(file, JSON.stringify(minimalSpec));
    const summaries = intentSpecFileToSummaries(file);
    expect(summaries).toHaveLength(1);
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

  it("walks recursively and returns one summary per *.intent.* file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "users.intent.json"),
      JSON.stringify(minimalSpec),
    );
    const subdir = path.join(tmpDir, "billing");
    fs.mkdirSync(subdir);
    fs.writeFileSync(
      path.join(subdir, "invoices.intent.json"),
      JSON.stringify({
        ...minimalSpec,
        boundary: { ...minimalSpec.boundary, path: "/invoices/:id" },
      }),
    );
    // A non-intent file should be ignored.
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# notes");

    const summaries = intentSpecDirectoryToSummaries(tmpDir);
    expect(summaries).toHaveLength(2);
    const paths = summaries
      .map((s) =>
        s.identity.boundaryBinding.semantics.name === "rest"
          ? s.identity.boundaryBinding.semantics.path
          : null,
      )
      .sort();
    expect(paths).toEqual(["/invoices/:id", "/users/:id"]);
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
