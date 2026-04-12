import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check } from "./check.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function transition(
  id: string,
  opts: {
    statusCode?: number;
    conditionStatus?: number;
    isDefault?: boolean;
  } = {},
): BehavioralSummary["transitions"][number] {
  const conditions =
    opts.conditionStatus !== undefined
      ? [
          {
            type: "comparison" as const,
            left: {
              type: "derived" as const,
              from: {
                type: "dependency" as const,
                name: "fetch",
                accessChain: [],
              },
              derivation: {
                type: "propertyAccess" as const,
                property: "status",
              },
            },
            op: "eq" as const,
            right: {
              type: "literal" as const,
              value: opts.conditionStatus,
            },
          },
        ]
      : [];
  return {
    id,
    conditions,
    output:
      opts.statusCode !== undefined
        ? {
            type: "response",
            statusCode: { type: "literal", value: opts.statusCode },
            body: null,
            headers: {},
          }
        : { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 10 },
    isDefault: opts.isDefault ?? false,
  };
}

function provider(
  name: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/handlers/${name}.ts`,
      range: { start: 1, end: 50 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: {
        protocol: "http",
        framework: "ts-rest",
        method: "GET",
        path: `/${name}`,
      },
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function consumer(
  name: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: `src/ui/${name}.ts`,
      range: { start: 1, end: 30 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: { protocol: "http", framework: "fetch" },
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("check CLI command", () => {
  let tmpDir: string;
  let providerPath: string;
  let consumerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-check-"));
    providerPath = path.join(tmpDir, "provider.json");
    consumerPath = path.join(tmpDir, "consumer.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  }

  it("emits zero findings when provider and consumer agree", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-404", { statusCode: 404 }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-404", { conditionStatus: 404 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      });
      expect(result.findings).toEqual([]);
      expect(result.hasErrors).toBe(false);
    });
    expect(output).toContain("No findings");
  });

  it("reports deadConsumerBranch when consumer expects a status the provider cannot produce", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const result = check({
      providerFile: providerPath,
      consumerFile: consumerPath,
      output: path.join(tmpDir, "findings.txt"),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("deadConsumerBranch");
    expect(result.findings[0].severity).toBe("warning");
    expect(result.hasErrors).toBe(false);
  });

  it("hasErrors is true when any finding has error severity", () => {
    const providerSummary = provider("getUser", [
      transition("t-200", { statusCode: 200, isDefault: true }),
    ]);
    providerSummary.metadata = {
      declaredContract: {
        framework: "ts-rest",
        responses: [{ statusCode: 200 }],
      },
    };
    fs.writeFileSync(providerPath, JSON.stringify([providerSummary]));
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-418", { conditionStatus: 418 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      });
      expect(result.hasErrors).toBe(true);
      const kinds = result.findings.map((f) => f.kind);
      expect(kinds).toContain("consumerContractViolation");
    });
  });

  it("--json writes structured JSON to stdout", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        json: true,
      });
    });
    const parsed = JSON.parse(output) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect((parsed as Array<{ kind: string }>)[0].kind).toBe(
      "deadConsumerBranch",
    );
  });

  it("-o output writes findings to the given file and skips stdout", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
    const outPath = path.join(tmpDir, "findings.json");

    const stdout = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        json: true,
        output: outPath,
      });
    });
    expect(stdout).toBe("");
    const onDisk = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].kind).toBe("deadConsumerBranch");
  });

  it("throws on missing provider file", () => {
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: path.join(tmpDir, "does-not-exist.json"),
        consumerFile: consumerPath,
      }),
    ).toThrow("File not found");
  });

  it("throws when summary JSON is not an array", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ not: "an array" }));
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      }),
    ).toThrow("Expected a JSON array");
  });
});
