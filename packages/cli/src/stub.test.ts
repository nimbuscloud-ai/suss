// stub.test.ts — `suss stub` CLI command tests

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stub } from "./stub.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const minimalSpec = {
  openapi: "3.0.3",
  info: { title: "stub-cli-test", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
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
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("stub CLI command", () => {
  let tmpDir: string;
  let specFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-stub-cli-"));
    specFile = path.join(tmpDir, "spec.json");
    fs.writeFileSync(specFile, JSON.stringify(minimalSpec));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns summaries from an OpenAPI spec via --from openapi", async () => {
    const writeFn = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let summaries: BehavioralSummary[];
    try {
      summaries = await stub({ from: "openapi", spec: specFile });
    } finally {
      process.stdout.write = writeFn;
    }
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("handler");
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].confidence).toEqual({
      source: "stub",
      level: "high",
    });
  });

  it("writes summaries to the output file when -o is given", async () => {
    const outFile = path.join(tmpDir, "out.json");
    const writeErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await stub({ from: "openapi", spec: specFile, output: outFile });
    } finally {
      process.stderr.write = writeErr;
    }
    expect(fs.existsSync(outFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("rejects an unknown --from value", async () => {
    await expect(
      stub({
        // Cast to bypass the StubSource literal type guard; this is what an
        // unknown CLI argument would look like at runtime.
        from: "graphql" as unknown as "openapi",
        spec: specFile,
      }),
    ).rejects.toThrow(/Unknown stub source/);
  });
});
