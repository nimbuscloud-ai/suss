// run.test.ts — argv-dispatch tests for the runCli surface.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli, USAGE } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  io: CapturedIO;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    exit,
    io: { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") },
  };
}

const minimalSummary: BehavioralSummary = {
  kind: "handler",
  location: { file: "x.ts", range: { start: 1, end: 5 }, exportName: "h" },
  identity: {
    name: "h",
    exportPath: ["h"],
    boundaryBinding: {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/x" },
      recognition: "test",
    },
  },
  inputs: [],
  transitions: [
    {
      id: "h:response:200:t",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
};

const matchingConsumer: BehavioralSummary = {
  ...minimalSummary,
  kind: "client",
  identity: {
    name: "c",
    exportPath: ["c"],
    boundaryBinding: {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/x" },
      recognition: "test",
    },
  },
  transitions: [
    {
      id: "c:return:none:t",
      conditions: [
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "dependency", name: "fetch", accessChain: [] },
            derivation: { type: "propertyAccess", property: "status" },
          },
          op: "eq",
          right: { type: "literal", value: 200 },
        },
      ],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: false,
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-runcli-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeJson(name: string, data: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

describe("runCli — top-level dispatch", () => {
  it("prints USAGE and exits 0 when no args are given", async () => {
    const { exit, io } = await capture(() => runCli([]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain(USAGE);
  });

  it("prints USAGE and exits 0 for --help", async () => {
    const { exit, io } = await capture(() => runCli(["--help"]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("Commands:");
  });

  it("prints USAGE and exits 0 for -h", async () => {
    const { exit, io } = await capture(() => runCli(["-h"]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("extract");
  });

  it("rejects unknown commands with a non-zero exit", async () => {
    const { exit, io } = await capture(() => runCli(["nope"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("Unknown command: nope");
  });
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe("runCli — extract", () => {
  it("rejects missing --project (-p)", async () => {
    const { exit, io } = await capture(() =>
      runCli(["extract", "-f", "axios"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--project (-p) is required");
  });

  it("rejects when no --framework (-f) is given", async () => {
    const { exit, io } = await capture(() =>
      runCli(["extract", "-p", "tsconfig.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("at least one --framework");
  });

  it("rejects an invalid --gaps value", async () => {
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "-p",
        "tsconfig.json",
        "-f",
        "axios",
        "--gaps",
        "bogus",
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--gaps must be");
  });
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe("runCli — inspect", () => {
  it("inspects a summaries file via positional path", async () => {
    const file = writeJson("summaries.json", [minimalSummary]);
    const { exit, io } = await capture(() => runCli(["inspect", file]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("/x");
  });

  it("rejects inspect with no path", async () => {
    const { exit, io } = await capture(() => runCli(["inspect"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("requires a summaries JSON file path");
  });

  it("inspect --diff requires before AND after paths", async () => {
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--diff", "only-one.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--diff requires two");
  });

  it("inspect --diff renders identical files cleanly", async () => {
    const a = writeJson("a.json", [minimalSummary]);
    const b = writeJson("b.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--diff", a, b]),
    );
    expect(exit).toBe(0);
    expect(io.stdout.length).toBeGreaterThan(0);
  });

  it("inspect --dir requires a directory path", async () => {
    const { exit, io } = await capture(() => runCli(["inspect", "--dir"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--dir requires a directory");
  });

  it("inspect --dir renders the pairings overview", async () => {
    writeJson("a.json", [minimalSummary]);
    writeJson("b.json", [matchingConsumer]);
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("paired boundary");
    expect(io.stdout).toContain("/x");
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe("runCli — check", () => {
  it("requires two positional files (or --dir)", async () => {
    const { exit, io } = await capture(() => runCli(["check"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("two summary file paths or --dir");
  });

  it("rejects an invalid --fail-on value", async () => {
    const { exit, io } = await capture(() =>
      runCli(["check", "--fail-on", "bogus", "p.json", "c.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--fail-on must be");
  });

  it("returns 0 when consumer covers every provider status", async () => {
    const provider = writeJson("provider.json", [minimalSummary]);
    const consumer = writeJson("consumer.json", [matchingConsumer]);
    const { exit } = await capture(() => runCli(["check", provider, consumer]));
    expect(exit).toBe(0);
  });

  it("returns 1 when the checker reports any error finding", async () => {
    // Provider declares 200 + 500; consumer only handles 200 → unhandled 500
    const provider = writeJson("provider.json", [
      {
        ...minimalSummary,
        transitions: [
          ...minimalSummary.transitions,
          {
            id: "h:response:500:t",
            conditions: [],
            output: {
              type: "response",
              statusCode: { type: "literal", value: 500 },
              body: null,
              headers: {},
            },
            effects: [],
            location: { start: 6, end: 7 },
            isDefault: false,
          },
        ],
      },
    ]);
    const consumer = writeJson("consumer.json", [matchingConsumer]);
    const { exit } = await capture(() => runCli(["check", provider, consumer]));
    expect(exit).toBe(1);
  });

  it("--dir reads every JSON file in the directory and pairs them", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("Paired");
  });
});

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

describe("runCli — contract", () => {
  const inlineSpec = {
    openapi: "3.0.3",
    info: { title: "users-api", version: "1.0" },
    paths: {
      "/users": {
        get: {
          operationId: "list",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("rejects missing --from", async () => {
    const { exit, io } = await capture(() => runCli(["contract", "spec.json"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--from is required");
  });

  it("rejects an unknown --from value", async () => {
    const { exit, io } = await capture(() =>
      runCli(["contract", "--from", "graphql", "spec.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("unknown --from value");
  });

  it("requires a positional spec path", async () => {
    const { exit, io } = await capture(() =>
      runCli(["contract", "--from", "openapi"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("requires a spec file path");
  });

  it("loads an OpenAPI spec and writes summaries to -o", async () => {
    const spec = writeJson("spec.json", inlineSpec);
    const out = path.join(tmpDir, "out.json");
    const { exit } = await capture(() =>
      runCli(["contract", "--from", "openapi", spec, "-o", out]),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const written = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(Array.isArray(written)).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("loads a CloudFormation template and writes summaries to -o", async () => {
    const tpl = writeJson("template.json", {
      Resources: {
        UsersApi: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineSpec },
        },
      },
    });
    const out = path.join(tmpDir, "out.json");
    const { exit } = await capture(() =>
      runCli(["contract", "--from", "cloudformation", tpl, "-o", out]),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });
});
