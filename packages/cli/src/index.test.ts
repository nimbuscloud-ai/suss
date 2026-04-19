// index.test.ts — CLI tests (Task 4.1)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { extract } from "./extract.js";
import { inspect } from "./inspect.js";

import type { BehavioralSummary, Predicate } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_ROOT = path.resolve(__dirname, "../../../fixtures");

function createTempTsConfig(fixtureDir: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: [path.join(fixtureDir, "**/*.ts")],
  };
  const tsconfigPath = path.join(tmpDir, "tsconfig.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  return tsconfigPath;
}

/**
 * Strip volatile fields (absolute filesystem path, content-addressable hashes)
 * so deep-equal assertions aren't brittle across machines. The transition ID
 * format is `${name}:${kind}:${statusKey}:${sha1-prefix}` — we keep the
 * stable prefix and drop the hash.
 */
function normalize(summary: BehavioralSummary): BehavioralSummary {
  return {
    ...summary,
    location: {
      ...summary.location,
      file: path.basename(summary.location.file),
    },
    transitions: summary.transitions.map((t) => ({
      ...t,
      id: t.id.replace(/:[0-9a-f]{7}$/, ":<hash>"),
    })),
  };
}

// ---------------------------------------------------------------------------
// extract — ts-rest fixtures
// ---------------------------------------------------------------------------

describe("extract — ts-rest", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  // ts-morph setup dominates the per-test time — run extract once.
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
    });
  }, 90_000);

  it("discovers exactly getUser and createUser", () => {
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "createUser",
      "getUser",
    ]);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
    }
  });

  it("getUser has the full expected shape (4 transitions, contract gaps, inputs)", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    if (getUser === undefined) {
      expect.unreachable("getUser handler not found");
    }

    // Kind, identity, and boundary binding from contract
    expect(getUser.kind).toBe("handler");
    expect(getUser.identity.name).toBe("getUser");
    expect(getUser.identity.exportPath).toEqual(["getUser"]);
    expect(getUser.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "core",
    });

    // Inputs: single destructured {params} mapped to pathParams
    expect(getUser.inputs).toEqual([
      {
        type: "parameter",
        name: "params",
        position: 0,
        role: "pathParams",
        shape: null,
      },
    ]);

    // Four transitions; assert stable IDs match the makeTransitionId scheme
    expect(getUser.transitions).toHaveLength(4);
    for (const t of getUser.transitions) {
      expect(t.id).toMatch(/^getUser:response:(200|404):[0-9a-f]{7}$/);
    }
    // Each body is an object literal with statically-enumerable fields,
    // so the extractor produces a structured record shape. String literals
    // preserve their narrow type (`{ literal, value }`); property-access
    // values (`user.id` etc.) resolve through the type checker to their
    // declared primitive types (here, `string` → `text`).
    expect(getUser.transitions.map((t) => t.output)).toEqual([
      {
        type: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "missing id" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "not found" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "deleted" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            id: { type: "text" },
            name: { type: "text" },
            email: { type: "text" },
          },
        },
        headers: {},
      },
    ]);
    expect(getUser.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    // Conditions: full chain for the 200 default branch — negations of each
    // prior guard's predicate.
    const defaultBranch = getUser.transitions[3];
    expect(defaultBranch.conditions).toHaveLength(3);
    for (const c of defaultBranch.conditions) {
      expect(c.type).toBe("negation");
    }

    // Gap: contract declares 500 that the handler never produces
    expect(getUser.gaps).toEqual([
      {
        type: "unhandledCase",
        conditions: [],
        consequence: "frameworkDefault",
        description: "Declared response 500 is never produced by the handler",
      },
    ]);

    // Declared contract preserved in metadata (under the HTTP namespace)
    const http = getUser.metadata?.http as Record<string, unknown> | undefined;
    expect(http?.declaredContract).toMatchObject({
      framework: "core",
      responses: expect.arrayContaining([
        expect.objectContaining({ statusCode: 200 }),
        expect.objectContaining({ statusCode: 404 }),
        expect.objectContaining({ statusCode: 500 }),
      ]),
    });

    expect(getUser.confidence).toEqual({
      source: "inferred_static",
      level: "high",
    });
  });

  it("createUser has exactly two transitions (400 guard, 201 default)", () => {
    const createUser = summaries.find((s) => s.identity.name === "createUser");
    if (createUser === undefined) {
      expect.unreachable("createUser not found");
    }
    expect(createUser.transitions.map((t) => t.output)).toEqual([
      {
        type: "response",
        statusCode: { type: "literal", value: 400 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "missing fields" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 201 },
        body: {
          type: "record",
          properties: { id: { type: "text" } },
        },
        headers: {},
      },
    ]);
    expect(createUser.transitions.map((t) => t.isDefault)).toEqual([
      false,
      true,
    ]);
    // No gaps — contract declares exactly 201 and 400, both produced.
    expect(createUser.gaps).toEqual([]);
  });

  it("writes exactly the in-memory summaries to -o output file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-out-"));
    const outPath = path.join(tmpDir, "output.json");

    const inMemory = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      output: outPath,
    });

    const onDisk = JSON.parse(
      fs.readFileSync(outPath, "utf-8"),
    ) as BehavioralSummary[];

    // Round-trip through the normalizer so volatile paths and hashes cancel.
    expect(onDisk.map(normalize)).toEqual(inMemory.map(normalize));

    fs.rmSync(tmpDir, { recursive: true });
  }, 90_000);
});

// ---------------------------------------------------------------------------
// extract — express fixtures
// ---------------------------------------------------------------------------

describe("extract — express", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "express");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["express"],
    });
  }, 90_000);

  it("extracts exactly three handlers (all registered via router.get)", () => {
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.name).toBe("get");
      expect(s.identity.boundaryBinding).toEqual({
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "express",
      });
      expect(s.gaps).toEqual([]);
    }
  });

  it("main /users/:id handler has full expected shape (4 transitions, positional inputs)", () => {
    const main = summaries.find((s) => s.transitions.length === 4);
    if (main === undefined) {
      expect.unreachable("main handler with 4 transitions not found");
    }

    // Positional inputs (req, res, next) mapped to framework roles.
    expect(main.inputs).toEqual([
      {
        type: "parameter",
        name: "req",
        position: 0,
        role: "request",
        shape: null,
      },
      {
        type: "parameter",
        name: "res",
        position: 1,
        role: "response",
        shape: null,
      },
      {
        type: "parameter",
        name: "next",
        position: 2,
        role: "next",
        shape: null,
      },
    ]);

    // Four response transitions, last two implicit-200 (no status on res.json()).
    // The admin branch spreads `user` — `user` has a declared type (id, name,
    // role), so the spread resolves via the type checker and its fields
    // inline alongside the explicit `admin: true`. The final branch is a
    // bare identifier (`res.json(user)`) — same type resolution flattens it
    // into a full record.
    expect(main.transitions.map((t) => t.output)).toEqual([
      {
        type: "response",
        statusCode: { type: "literal", value: 400 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "missing id" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "not found" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            admin: { type: "literal", value: true },
            id: { type: "text" },
            name: { type: "text" },
            role: { type: "text" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            id: { type: "text" },
            name: { type: "text" },
            role: { type: "text" },
          },
        },
        headers: {},
      },
    ]);
    expect(main.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    // Transition IDs are stable prefixes + short content hashes.
    for (const t of main.transitions) {
      expect(t.id).toMatch(/^get:response:(400|404|200|none):[0-9a-f]{7}$/);
    }
  });

  it("redirect handlers: 1-arg form → default 302, 2-arg form → 301", () => {
    const singleTxn = summaries.filter((s) => s.transitions.length === 1);
    expect(singleTxn).toHaveLength(2);

    const codes = singleTxn.map((s) =>
      s.transitions[0].output.type === "response"
        ? s.transitions[0].output.statusCode
        : "not-response",
    );
    expect(codes).toContainEqual({ type: "literal", value: 302 });
    expect(codes).toContainEqual({ type: "literal", value: 301 });
  });
});

// ---------------------------------------------------------------------------
// extract — react-router fixtures
// ---------------------------------------------------------------------------

describe("extract — react-router", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "react-router");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["react-router"],
    });
  }, 90_000);

  it("extracts exactly the loader and action from the fixture route", () => {
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.kind).sort()).toEqual(["action", "loader"]);
    for (const s of summaries) {
      expect(s.identity.boundaryBinding).toEqual({
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "react-router",
      });
      expect(s.gaps).toEqual([]);
    }
  });

  it("loader has full expected shape — three response transitions with default status codes", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    if (loader === undefined) {
      expect.unreachable("loader not found");
    }

    // Single destructured params object mapped to role "request".
    expect(loader.inputs).toEqual([
      {
        type: "parameter",
        name: "{ params }",
        position: 0,
        role: "request",
        shape: null,
      },
    ]);

    // Three response transitions. json() defaults to 200, redirect() to 302.
    expect(loader.transitions).toHaveLength(3);
    expect(loader.transitions.map((t) => t.output)).toEqual([
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "not found" },
          },
        },
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 302 },
        body: null,
        headers: {},
      },
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            user: {
              type: "record",
              properties: {
                id: { type: "text" },
                name: { type: "text" },
                active: { type: "boolean" },
              },
            },
          },
        },
        headers: {},
      },
    ]);
    expect(loader.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      true,
    ]);

    expect(loader.confidence).toEqual({
      source: "inferred_static",
      level: "high",
    });
  });

  it("loader conditions resolve to structured predicates (no opaque)", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    if (loader === undefined) {
      expect.unreachable("loader not found");
    }
    const allConditions: Predicate[] = loader.transitions.flatMap(
      (t) => t.conditions,
    );
    expect(allConditions.length).toBeGreaterThan(0);
    for (const c of allConditions) {
      expect(c.type).not.toBe("opaque");
    }
  });

  it("action has full expected shape — two response transitions", () => {
    const action = summaries.find((s) => s.kind === "action");
    if (action === undefined) {
      expect.unreachable("action not found");
    }
    expect(action.transitions).toHaveLength(2);
    expect(action.transitions.map((t) => t.output)).toEqual([
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            error: { type: "literal", value: "name required" },
          },
        },
        headers: {},
      },
      // Final redirect defaults to 302 — body is null.
      {
        type: "response",
        statusCode: { type: "literal", value: 302 },
        body: null,
        headers: {},
      },
    ]);
    expect(action.transitions.map((t) => t.isDefault)).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// extract — error cases
// ---------------------------------------------------------------------------

describe("extract — errors", () => {
  it("throws on missing tsconfig", async () => {
    await expect(
      extract({
        tsconfig: "/nonexistent/tsconfig.json",
        frameworks: ["express"],
      }),
    ).rejects.toThrow("tsconfig not found");
  });

  it("throws on unknown framework", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));

    await expect(
      extract({
        tsconfig: tsconfigPath,
        frameworks: ["nonexistent-framework"],
      }),
    ).rejects.toThrow("Unknown framework");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throws on empty frameworks list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-"));
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));

    await expect(
      extract({
        tsconfig: tsconfigPath,
        frameworks: [],
      }),
    ).rejects.toThrow("At least one framework");

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe("inspect", () => {
  it(
    "formats summaries JSON to human-readable output",
    { timeout: 90_000 },
    async () => {
      // First extract, then inspect the output
      const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
      const tsconfigPath = createTempTsConfig(fixtureDir);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-inspect-"));
      const outPath = path.join(tmpDir, "summaries.json");

      await extract({
        tsconfig: tsconfigPath,
        frameworks: ["ts-rest"],
        output: outPath,
      });

      // Capture stdout
      const chunks: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        inspect({ file: outPath });
      } finally {
        process.stdout.write = origWrite;
      }

      const output = chunks.join("");
      expect(output).toContain("GET /users/:id");
      expect(output).toContain("-> 200");
      expect(output).toContain("Contract:");
      expect(output).toContain("summaries inspected");

      // Clean up
      fs.rmSync(tmpDir, { recursive: true });
    },
  );

  it("throws on nonexistent file", () => {
    expect(() => inspect({ file: "/nonexistent/file.json" })).toThrow(
      "File not found",
    );
  });
});

// ---------------------------------------------------------------------------
// Consumer extraction — fetch
// ---------------------------------------------------------------------------

describe("consumer extraction — fetch", () => {
  it(
    "discovers consumer functions from fetch fixture",
    { timeout: 90_000 },
    async () => {
      const tsconfigPath = createTempTsConfig(
        path.join(FIXTURES_ROOT, "fetch"),
      );
      const tmpDir = path.dirname(tsconfigPath);
      const outPath = path.join(tmpDir, "summaries.json");

      const summaries = await extract({
        tsconfig: tsconfigPath,
        frameworks: ["fetch"],
        output: outPath,
      });

      expect(summaries).toHaveLength(2);

      const health = summaries.find((s) => s.identity.name === "getHealth");
      expect(health).toBeDefined();
      if (health) {
        expect(health.kind).toBe("client");
        const sem = health.identity.boundaryBinding?.semantics;
        expect(sem?.name).toBe("rest");
        if (sem?.name === "rest") {
          expect(sem.path).toBe("/health");
          expect(sem.method).toBe("GET");
        }
        expect(health.transitions.length).toBeGreaterThanOrEqual(2);
      }

      const user = summaries.find((s) => s.identity.name === "getUser");
      expect(user).toBeDefined();
      if (user) {
        expect(user.kind).toBe("client");
      }

      fs.rmSync(tmpDir, { recursive: true });
    },
  );
});

// ---------------------------------------------------------------------------
// End-to-end: extract + check with ts-rest provider and consumer
// ---------------------------------------------------------------------------

describe("end-to-end: extract provider + consumer, then check", () => {
  it(
    "produces findings when consumer misses a status the provider can produce",
    { timeout: 90_000 },
    async () => {
      // Extract provider from ts-rest fixture
      const providerTsconfig = createTempTsConfig(
        path.join(FIXTURES_ROOT, "ts-rest"),
      );
      const providerTmpDir = path.dirname(providerTsconfig);
      const providerOutPath = path.join(providerTmpDir, "provider.json");
      await extract({
        tsconfig: providerTsconfig,
        frameworks: ["ts-rest"],
        output: providerOutPath,
      });

      // Extract consumer from fetch fixture (simulated consumer)
      const consumerTsconfig = createTempTsConfig(
        path.join(FIXTURES_ROOT, "fetch"),
      );
      const consumerTmpDir = path.dirname(consumerTsconfig);
      const consumerOutPath = path.join(consumerTmpDir, "consumer.json");
      await extract({
        tsconfig: consumerTsconfig,
        frameworks: ["fetch"],
        output: consumerOutPath,
      });

      // Check provider against consumer
      const { check } = await import("./check.js");
      const result = check({
        providerFile: providerOutPath,
        consumerFile: consumerOutPath,
      });

      // The provider (ts-rest) produces multiple statuses (200, 404, 400, 201);
      // the consumer (fetch/getHealth) only handles 200 and 503.
      // Provider coverage should flag unhandled provider cases.
      expect(result.findings.length).toBeGreaterThan(0);

      fs.rmSync(providerTmpDir, { recursive: true });
      fs.rmSync(consumerTmpDir, { recursive: true });
    },
  );
});

// ---------------------------------------------------------------------------
// End-to-end: semantic bridging (the motivating example)
// ---------------------------------------------------------------------------

describe("end-to-end: semantic bridging — soft-delete motivating example", () => {
  it(
    "detects that consumer ignores provider's distinguishing body.status literal",
    { timeout: 90_000 },
    async () => {
      // Extract provider from semantic-bridging fixture
      const providerTsconfig = createTempTsConfig(
        path.join(FIXTURES_ROOT, "semantic-bridging"),
      );
      const providerTmpDir = path.dirname(providerTsconfig);
      const providerOutPath = path.join(providerTmpDir, "provider.json");
      await extract({
        tsconfig: providerTsconfig,
        frameworks: ["ts-rest"],
        files: [
          path.join(FIXTURES_ROOT, "semantic-bridging", "handler.ts"),
          path.join(FIXTURES_ROOT, "semantic-bridging", "contract.ts"),
        ],
        output: providerOutPath,
      });

      // Extract consumer from semantic-bridging fixture
      const consumerTsconfig = createTempTsConfig(
        path.join(FIXTURES_ROOT, "semantic-bridging"),
      );
      const consumerTmpDir = path.dirname(consumerTsconfig);
      const consumerOutPath = path.join(consumerTmpDir, "consumer.json");
      await extract({
        tsconfig: consumerTsconfig,
        frameworks: ["ts-rest"],
        files: [
          path.join(FIXTURES_ROOT, "semantic-bridging", "consumer.ts"),
          path.join(FIXTURES_ROOT, "semantic-bridging", "contract.ts"),
        ],
        output: consumerOutPath,
      });

      // Verify provider has multiple 200 transitions
      const providerSummaries: BehavioralSummary[] = JSON.parse(
        fs.readFileSync(providerOutPath, "utf8"),
      );
      const getUser = providerSummaries.find(
        (s) => s.identity.name === "getUser",
      );
      expect(getUser).toBeDefined();
      const provider200s = getUser?.transitions.filter(
        (t) =>
          t.output.type === "response" &&
          t.output.statusCode?.type === "literal" &&
          t.output.statusCode.value === 200,
      );
      expect(provider200s?.length).toBeGreaterThanOrEqual(2);

      // Check provider against consumer
      const { check } = await import("./check.js");
      const result = check({
        providerFile: providerOutPath,
        consumerFile: consumerOutPath,
      });

      // Should have a finding about the distinguishing "deleted" literal
      // that the consumer ignores
      const semanticFindings = result.findings.filter(
        (f: { description: string }) =>
          f.description.includes("deleted") ||
          f.description.includes("distinct cases") ||
          f.description.includes("status"),
      );
      expect(semanticFindings.length).toBeGreaterThan(0);

      fs.rmSync(providerTmpDir, { recursive: true });
      fs.rmSync(consumerTmpDir, { recursive: true });
    },
  );
});
