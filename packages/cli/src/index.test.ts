// index.test.ts: CLI tests (Task 4.1)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { readHttpMetadata } from "@suss/behavioral-ir";

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
 * format is `${name}:${kind}:${statusKey}:${sha1-prefix}`: we keep the
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
// extract: ts-rest fixtures
// ---------------------------------------------------------------------------

describe("extract: ts-rest", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  // ts-morph setup dominates the per-test time: run extract once.
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
      recognition: "ts-rest",
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

    // Conditions: full chain for the 200 default branch: negations of each
    // prior guard's predicate.
    const defaultBranch = getUser.transitions[3];
    expect(defaultBranch.conditions).toHaveLength(3);
    for (const c of defaultBranch.conditions) {
      expect(c.type).toBe("negation");
    }

    // Gap: contract declares 500 that the handler never produces, and
    // the fixture declares `db` without implementing it.
    expect(getUser.gaps).toEqual([
      {
        type: "unhandledCase",
        conditions: [],
        consequence: "frameworkDefault",
        description: "Declared response 500 is never produced by the handler",
      },
      {
        type: "unfollowedCall",
        conditions: [],
        consequence: "unknown",
        description: expect.stringContaining("db.findById"),
        callee: "db.findById",
      },
    ]);

    // Declared contract preserved in metadata (under the HTTP namespace)
    expect(readHttpMetadata(getUser)?.declaredContract).toMatchObject({
      framework: "ts-rest",
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
    // Contract declares exactly 201 and 400, both produced, so the only
    // gap left is the call into the `db` the fixture never implements.
    expect(createUser.gaps.map((g) => g.type)).toEqual(["unfollowedCall"]);
    expect(createUser.gaps[0]?.description).toContain("db.createUser");
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
// extract, --gaps modes
// ---------------------------------------------------------------------------

describe("extract, --gaps modes", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "ts-rest");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  it("permissive records the getUser gap and leaves the run passing", async () => {
    const previous = process.exitCode;
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      gaps: "permissive",
    });
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.gaps.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(previous);
    process.exitCode = previous;
  }, 90_000);

  it("strict records the same gaps as permissive, then fails the run", async () => {
    const previous = process.exitCode;

    const permissive = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      gaps: "permissive",
    });
    process.exitCode = previous;

    const strict = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      gaps: "strict",
    });

    // Extraction is identical between the two modes; strict only adds an
    // exit-code decision on top of what permissive already wrote.
    expect(strict.map(normalize)).toEqual(permissive.map(normalize));
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  }, 90_000);

  it("silent records no gaps and leaves the run passing", async () => {
    const previous = process.exitCode;
    const summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["ts-rest"],
      gaps: "silent",
    });
    for (const s of summaries) {
      expect(s.gaps).toEqual([]);
    }
    expect(process.exitCode).toBe(previous);
    process.exitCode = previous;
  }, 90_000);

  it("still fails a strict run that answered from a warm cache", async () => {
    // A fresh tsconfig, so this test owns its own cache directory and
    // the second call's hit can't be a leftover from an earlier test.
    const warmTsconfig = createTempTsConfig(fixtureDir);
    const previous = process.exitCode;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    let first: BehavioralSummary[];
    let second: BehavioralSummary[];
    try {
      first = await extract({
        tsconfig: warmTsconfig,
        frameworks: ["ts-rest"],
        gaps: "strict",
        timing: true,
      });
      process.exitCode = previous;
      stderrChunks.length = 0;

      second = await extract({
        tsconfig: warmTsconfig,
        frameworks: ["ts-rest"],
        gaps: "strict",
        timing: true,
      });
    } finally {
      process.stderr.write = origWrite;
    }

    // The cache key folds gapHandling in, so two strict runs against
    // the same tsconfig share an entry: the second call is served from
    // the manifest the first one wrote, gaps and all, and still fails.
    expect(stderrChunks.join("")).toContain("cache: hit");
    expect(second.map(normalize)).toEqual(first.map(normalize));
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  }, 90_000);
});

// ---------------------------------------------------------------------------
// extract: express fixtures
// ---------------------------------------------------------------------------

describe("extract: express", () => {
  const fixtureDir = path.join(FIXTURES_ROOT, "express");
  const tsconfigPath = createTempTsConfig(fixtureDir);

  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await extract({
      tsconfig: tsconfigPath,
      frameworks: ["express"],
    });
  }, 90_000);

  it("extracts every handler the fixture registers", () => {
    expect(summaries).toHaveLength(4);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.boundaryBinding?.transport).toBe("http");
      expect(s.identity.boundaryBinding?.recognition).toBe("express");
      expect(s.identity.boundaryBinding?.semantics.name).toBe("rest");
    }
    // The fixture declares `db` and never implements it, so the one
    // handler that calls it says where the walk stopped.
    expect(summaries.flatMap((s) => s.gaps).map((g) => g.type)).toEqual([
      "unfollowedCall",
    ]);
    expect(summaries.flatMap((s) => s.gaps)[0]?.description).toContain(
      "db.findById",
    );
    const paths = summaries
      .map((s) => {
        const sem = s.identity.boundaryBinding?.semantics;
        return sem?.name === "rest" ? sem.path : null;
      })
      .filter((p): p is string => p !== null)
      .sort();
    expect(paths).toEqual([
      "/moved",
      "/old-profile",
      "/users/:id",
      "/webhooks/:source",
    ]);
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
    // The admin branch spreads `user`: `user` has a declared type (id, name,
    // role), so the spread resolves via the type checker and its fields
    // inline alongside the explicit `admin: true`. The final branch is a
    // bare identifier (`res.json(user)`): same type resolution flattens it
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
    // The webhook catch-all is the third single-transition handler.
    const singleTxn = summaries.filter((s) => s.transitions.length === 1);
    expect(singleTxn).toHaveLength(3);

    const codes = singleTxn.map((s) =>
      s.transitions[0].output.type === "response"
        ? s.transitions[0].output.statusCode
        : "not-response",
    );
    expect(codes).toContainEqual({ type: "literal", value: 302 });
    expect(codes).toContainEqual({ type: "literal", value: 301 });
  });

  it("renders no follow marker for a Promise.all call beside the .all route", () => {
    // The .all handler is label-named "all"; a follow marker would
    // claim Promise.all reaches it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-all-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(file, JSON.stringify(summaries));

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      inspect({ file });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("Promise.all");
    expect(output).not.toMatch(/Promise\.all[^\n]*→/);
    expect(output).not.toContain("handlers.all");

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// extract: react-router fixtures
// ---------------------------------------------------------------------------

describe("extract: react-router", () => {
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
    }
    // `db` is declared and never implemented, so the loader and the
    // action each say which call the walk stopped at.
    expect(summaries.flatMap((s) => s.gaps).map((g) => g.description)).toEqual([
      expect.stringContaining("db.findById"),
      expect.stringContaining("db.updateUser"),
    ]);
  });

  it("loader has full expected shape: three response transitions with default status codes", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    if (loader === undefined) {
      expect.unreachable("loader not found");
    }

    // The loader writes `{ params }`, and the pack declares that params
    // is the path parameters, so the input says so.
    expect(loader.inputs).toEqual([
      {
        type: "parameter",
        name: "params",
        position: 0,
        role: "pathParams",
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

  it("action has full expected shape: two response transitions", () => {
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
      // Final redirect defaults to 302: body is null.
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
// extract: error cases
// ---------------------------------------------------------------------------

describe("extract: errors", () => {
  it("throws on missing tsconfig", async () => {
    await expect(
      extract({
        tsconfig: "/nonexistent/tsconfig.json",
        frameworks: ["express"],
      }),
    ).rejects.toThrow("No tsconfig at");
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
    ).rejects.toThrow("Unknown pack");

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
    ).rejects.toThrow("at least one pack");

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
      expect(output).toContain("GET /users/{id}");
      expect(output).toContain("-> 200");
      expect(output).toContain("Contract:");
      expect(output).toMatch(/\d+ summar(y|ies)\./);

      // Clean up
      fs.rmSync(tmpDir, { recursive: true });
    },
  );

  it("shows a queue subscriber's channel next to its name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-bus-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        busSummary("OrderPlacedFunction.QueueEvent", "default#order.placed"),
        // A queue declared by a template is named after its own
        // channel, where showing both would stutter.
        busSummary("OrdersQueue", "OrdersQueue"),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    expect(output).toContain(
      "OrderPlacedFunction.QueueEvent → aws_sqs default#order.placed",
    );
    expect(output).toContain("aws_sqs OrdersQueue");
    expect(output).not.toContain("OrdersQueue → aws_sqs OrdersQueue");

    fs.rmSync(dir, { recursive: true });
  });

  it("says 2XX, 4XX, and default for a range-coded provider", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-range-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(file, JSON.stringify([rangeCodedProviderSummary()]));

    const output = captureInspect(() => inspect({ file }));
    expect(output).toContain("Contract: 2XX, 4XX, default");
    expect(output).toContain("-> 2XX");
    expect(output).toContain("-> 4XX");
    expect(output).toContain("-> default");
    expect(output).not.toContain("???");
    expect(output).not.toContain("!! undeclared");

    fs.rmSync(dir, { recursive: true });
  });

  it("throws on nonexistent file", () => {
    expect(() => inspect({ file: "/nonexistent/file.json" })).toThrow(
      "File not found",
    );
  });

  // A component's click handler calling its own "onChange" prop and an
  // unrelated Form's "onChange" handler both spell the same name.
  // Inspect used to resolve every call that way, so whichever summary
  // loaded first for a name won, regardless of which one a call
  // actually reached.
  it("without an id, says nothing when a name several files answer to", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-byname-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        // Two files define onChange, so a name-only match cannot pick
        // one, and pointing at either would invent a call-graph edge.
        onChangeHandlerSummary("src/Form.tsx"),
        onChangeHandlerSummary("src/Counter.tsx"),
        counterSummary({}),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    expect(output).not.toContain("src/Form.onChange");

    fs.rmSync(dir, { recursive: true });
  });

  it("without an id, still links a name only one file answers to", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-byname-one-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        onChangeHandlerSummary("src/Form.tsx"),
        counterSummary({}),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    expect(output).toContain("+ src/Form.onChange →");

    fs.rmSync(dir, { recursive: true });
  });

  it("with an id, follows the call to the summary it actually reaches, not a name match", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-byid-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        onChangeHandlerSummary("src/Form.tsx", "form::onChange"),
        onChangeHandlerSummary("src/Counter.tsx", "counter::onChange"),
        counterSummary({ effectSummary: "counter::onChange" }),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    // The id says this call reaches Counter's own onChange, in the
    // same file, so the arrow is bare rather than pointing at Form.
    expect(output).toContain("+ onChange →");
    expect(output).not.toContain("Form.onChange");

    fs.rmSync(dir, { recursive: true });
  });

  it("with an id, path-qualifies a call the id resolves to a different file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-byid-cross-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        onChangeHandlerSummary("src/Form.tsx", "form::onChange"),
        counterSummary({ effectSummary: "form::onChange" }),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    expect(output).toContain("+ src/Form.onChange →");

    fs.rmSync(dir, { recursive: true });
  });

  it("with an id the loaded set doesn't answer to, shows the call bare rather than guessing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-byid-miss-"));
    const file = path.join(dir, "summaries.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        onChangeHandlerSummary("src/Form.tsx"),
        counterSummary({ effectSummary: "counter::onChange" }),
      ]),
    );

    const output = captureInspect(() => inspect({ file }));
    expect(output).toContain("+ onChange\n");
    expect(output).not.toContain("+ onChange →");

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Consumer extraction: fetch
// ---------------------------------------------------------------------------

describe("consumer extraction: fetch", () => {
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

describe("end-to-end: semantic bridging: soft-delete motivating example", () => {
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

/** A minimal summary carrying a message-bus binding. */
function busSummary(name: string, channel: string): unknown {
  return {
    kind: "consumer",
    location: {
      file: "src/handler.ts",
      range: { start: 1, end: 2 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: {
        transport: "sqs",
        semantics: { name: "message-bus", messageBus: "aws_sqs", channel },
        recognition: "aws-sqs",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** A minimal named handler summary, optionally carrying an id. */
function onChangeHandlerSummary(file: string, id?: string): unknown {
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 2 }, exportName: "onChange" },
    identity: {
      name: "onChange",
      exportPath: ["onChange"],
      boundaryBinding: null,
      ...(id !== undefined ? { id } : {}),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/**
 * A `Counter` component whose click handler calls a callee named
 * "onChange", the way a prop call reads once destructured. Pass
 * `effectSummary` to simulate what the extractor stamps once it has
 * resolved that call to a specific summary's id.
 */
function counterSummary(opts: { effectSummary?: string }): unknown {
  return {
    kind: "component",
    location: {
      file: "src/Counter.tsx",
      range: { start: 10, end: 20 },
      exportName: "Counter",
    },
    identity: {
      name: "Counter",
      exportPath: ["Counter"],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [
      {
        id: "t1",
        conditions: [],
        output: { type: "void" },
        effects: [
          {
            type: "invocation",
            callee: "onChange",
            args: [],
            async: false,
            ...(opts.effectSummary !== undefined
              ? { summary: opts.effectSummary }
              : {}),
          },
        ],
        location: { start: 10, end: 20 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** What the OpenAPI reader emits for an operation coded 2XX / 4XX / default. */
function rangeCodedProviderSummary(): unknown {
  const rangeTransition = (spec: string, min: number, max: number) => ({
    id: `getPet:response:${spec}:stub`,
    conditions: [],
    output: { type: "response", statusCode: null, body: null, headers: {} },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
    metadata: { http: { statusRange: { min, max, spec } } },
  });
  return {
    kind: "handler",
    location: {
      file: "openapi:pets",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: "getPet",
      exportPath: null,
      boundaryBinding: {
        transport: "http",
        semantics: { name: "rest", method: "GET", path: "/pets/{id}" },
        recognition: "openapi",
      },
    },
    inputs: [],
    transitions: [
      rangeTransition("2XX", 200, 299),
      rangeTransition("4XX", 400, 499),
      {
        id: "getPet:response:default:stub",
        conditions: [],
        output: { type: "response", statusCode: null, body: null, headers: {} },
        effects: [],
        location: { start: 0, end: 0 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: {
      http: {
        declaredContract: {
          framework: "openapi",
          provenance: "derived",
          responses: [],
          responseRanges: [
            { min: 200, max: 299, spec: "2XX" },
            { min: 400, max: 499, spec: "4XX" },
          ],
          defaultResponse: {},
        },
      },
    },
  };
}

/** Run inspect with stdout captured. */
function captureInspect(run: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}
