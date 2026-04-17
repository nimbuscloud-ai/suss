// snapshot.test.ts — Snapshot tests for human-readable CLI output
//
// These tests pin the exact rendering of inspect, inspect --diff, and check
// output so format changes are visible in diffs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspect, inspectDiff, inspectDir } from "./inspect.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join("");
}

function writeTempJson(data: unknown): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-snap-"));
  const filePath = path.join(tmpDir, "summaries.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const handlerSummary: BehavioralSummary = {
  kind: "handler",
  location: {
    file: "src/handlers/users.ts",
    range: { start: 10, end: 45 },
    exportName: "getUser",
  },
  identity: {
    name: "getUser",
    exportPath: ["getUser"],
    boundaryBinding: {
      protocol: "http",
      method: "GET",
      path: "/users/:id",
      framework: "express",
    },
  },
  inputs: [
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
  ],
  transitions: [
    {
      id: "getUser:response:400:abc1234",
      conditions: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: {
              type: "derived",
              from: { type: "input", inputRef: "req", path: [] },
              derivation: { type: "propertyAccess", property: "params" },
            },
            derivation: { type: "propertyAccess", property: "id" },
          },
          negated: true,
        },
      ],
      output: {
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
      effects: [],
      location: { start: 12, end: 14 },
      isDefault: false,
    },
    {
      id: "getUser:response:404:def5678",
      conditions: [
        {
          type: "nullCheck",
          subject: { type: "dependency", name: "db.findById", accessChain: [] },
          negated: false,
        },
      ],
      output: {
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
      effects: [],
      location: { start: 18, end: 20 },
      isDefault: false,
    },
    {
      id: "getUser:response:200:aaa0000",
      conditions: [],
      output: {
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
      effects: [],
      location: { start: 22, end: 30 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
  metadata: {
    declaredContract: {
      framework: "express",
      responses: [
        { statusCode: 200 },
        { statusCode: 400 },
        { statusCode: 404 },
        { statusCode: 500 },
      ],
    },
  },
};

const clientSummary: BehavioralSummary = {
  kind: "client",
  location: {
    file: "src/pages/user.ts",
    range: { start: 5, end: 20 },
    exportName: "loadUser",
  },
  identity: {
    name: "loadUser",
    exportPath: ["loadUser"],
    boundaryBinding: {
      protocol: "http",
      method: "GET",
      path: "/users/:id",
      framework: "fetch",
    },
  },
  inputs: [],
  transitions: [
    {
      id: "loadUser:throw:none:bbb1111",
      conditions: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "dependency", name: "fetch", accessChain: [] },
            derivation: { type: "propertyAccess", property: "ok" },
          },
          negated: true,
        },
      ],
      output: { type: "throw", exceptionType: "Error", message: null },
      effects: [],
      location: { start: 8, end: 10 },
      isDefault: false,
    },
    {
      id: "loadUser:return:none:ccc2222",
      conditions: [],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 12, end: 14 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
};

// ---------------------------------------------------------------------------
// Inspect snapshots
// ---------------------------------------------------------------------------

describe("inspect output snapshots", () => {
  it("renders a handler with contract and body shapes", () => {
    const filePath = writeTempJson([handlerSummary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders a client summary", () => {
    const filePath = writeTempJson([clientSummary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders multiple summaries", () => {
    const filePath = writeTempJson([handlerSummary, clientSummary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Diff snapshots
// ---------------------------------------------------------------------------

describe("inspect --diff output snapshots", () => {
  it("shows no changes for identical files", () => {
    const f1 = writeTempJson([handlerSummary]);
    const f2 = writeTempJson([handlerSummary]);
    const output = captureStdout(() => inspectDiff({ before: f1, after: f2 }));
    fs.rmSync(path.dirname(f1), { recursive: true });
    fs.rmSync(path.dirname(f2), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("shows added transition", () => {
    const newTransition: Transition = {
      id: "getUser:response:403:eee4444",
      conditions: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: { type: "dependency", name: "db.findById", accessChain: [] },
            derivation: { type: "propertyAccess", property: "restricted" },
          },
          negated: false,
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 403 },
        body: {
          type: "record",
          properties: { error: { type: "literal", value: "forbidden" } },
        },
        headers: {},
      },
      effects: [],
      location: { start: 25, end: 27 },
      isDefault: false,
    };

    const afterSummary = {
      ...handlerSummary,
      transitions: [...handlerSummary.transitions, newTransition],
    };

    const f1 = writeTempJson([handlerSummary]);
    const f2 = writeTempJson([afterSummary]);
    const output = captureStdout(() => inspectDiff({ before: f1, after: f2 }));
    fs.rmSync(path.dirname(f1), { recursive: true });
    fs.rmSync(path.dirname(f2), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("shows removed transition", () => {
    const afterSummary = {
      ...handlerSummary,
      transitions: handlerSummary.transitions.slice(0, 2),
    };

    const f1 = writeTempJson([handlerSummary]);
    const f2 = writeTempJson([afterSummary]);
    const output = captureStdout(() => inspectDiff({ before: f1, after: f2 }));
    fs.rmSync(path.dirname(f1), { recursive: true });
    fs.rmSync(path.dirname(f2), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("shows changed transition", () => {
    const changedTransition: Transition = {
      ...handlerSummary.transitions[2],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            id: { type: "text" },
            name: { type: "text" },
            email: { type: "text" },
            avatar: { type: "text" },
          },
        },
        headers: {},
      },
    };

    const afterSummary = {
      ...handlerSummary,
      transitions: [
        handlerSummary.transitions[0],
        handlerSummary.transitions[1],
        changedTransition,
      ],
    };

    const f1 = writeTempJson([handlerSummary]);
    const f2 = writeTempJson([afterSummary]);
    const output = captureStdout(() => inspectDiff({ before: f1, after: f2 }));
    fs.rmSync(path.dirname(f1), { recursive: true });
    fs.rmSync(path.dirname(f2), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("shows new and removed summaries", () => {
    const f1 = writeTempJson([handlerSummary]);
    const f2 = writeTempJson([clientSummary]);
    const output = captureStdout(() => inspectDiff({ before: f1, after: f2 }));
    fs.rmSync(path.dirname(f1), { recursive: true });
    fs.rmSync(path.dirname(f2), { recursive: true });
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Dir snapshots
// ---------------------------------------------------------------------------

function writeTempDir(files: Record<string, BehavioralSummary[]>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-dir-"));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data, null, 2));
  }
  return tmpDir;
}

describe("inspect --dir output snapshots", () => {
  it("shows paired boundaries with transition counts", () => {
    const dir = writeTempDir({
      "providers.json": [handlerSummary],
      "consumers.json": [clientSummary],
    });
    const output = captureStdout(() => inspectDir({ dir }));
    fs.rmSync(dir, { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("shows unmatched summaries", () => {
    const dir = writeTempDir({
      "providers.json": [handlerSummary],
    });
    const output = captureStdout(() => inspectDir({ dir }));
    fs.rmSync(dir, { recursive: true });
    expect(output).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Variant coverage — exercises individual TypeShape / Predicate / ValueRef /
// Output / Derivation cases through the inspect renderer so the typed
// dispatch maps don't silently drop coverage when new variants land.
// ---------------------------------------------------------------------------

function makeHandlerWith(
  overrides: Partial<Transition> & { conditions?: Transition["conditions"] },
): BehavioralSummary {
  return {
    ...handlerSummary,
    transitions: [
      {
        id: "h:variant:t",
        conditions: [],
        output: { type: "void" },
        effects: [],
        location: { start: 12, end: 14 },
        isDefault: false,
        ...overrides,
      },
    ],
  };
}

describe("inspect variant rendering", () => {
  it("renders every primitive TypeShape variant in body shapes", () => {
    const summary = makeHandlerWith({
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            text: { type: "text" },
            int: { type: "integer" },
            num: { type: "number" },
            bool: { type: "boolean" },
            n: { type: "null" },
          },
        },
        headers: {},
      },
    });
    const filePath = writeTempJson([summary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders union, array, dictionary, ref, literal, undefined, unknown TypeShapes", () => {
    const summary = makeHandlerWith({
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: {
          type: "record",
          properties: {
            tags: { type: "array", items: { type: "text" } },
            byKey: { type: "dictionary", values: { type: "integer" } },
            shape: { type: "ref", name: "Pet" },
            literal: { type: "literal", value: "ok" },
            optional: {
              type: "union",
              variants: [{ type: "text" }, { type: "undefined" }],
            },
            anything: { type: "unknown" },
          },
        },
        headers: {},
      },
    });
    const filePath = writeTempJson([summary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders every Predicate variant", () => {
    const summary = makeHandlerWith({
      conditions: [
        // comparison
        {
          type: "comparison",
          left: { type: "literal", value: 1 },
          op: "neq",
          right: { type: "literal", value: 2 },
        },
        // truthinessCheck (positive + negated)
        {
          type: "truthinessCheck",
          subject: { type: "input", inputRef: "req", path: ["query", "id"] },
          negated: false,
        },
        // nullCheck
        {
          type: "nullCheck",
          subject: { type: "dependency", name: "db.findById", accessChain: [] },
          negated: false,
        },
        // typeCheck
        {
          type: "typeCheck",
          subject: { type: "input", inputRef: "err", path: [] },
          expectedType: "Error",
        },
        // propertyExists
        {
          type: "propertyExists",
          subject: { type: "input", inputRef: "obj", path: [] },
          property: "id",
          negated: true,
        },
        // call
        {
          type: "call",
          callee: "isValid",
          args: [{ type: "input", inputRef: "x", path: [] }],
        },
        // compound
        {
          type: "compound",
          op: "or",
          operands: [
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "a", path: [] },
              negated: false,
            },
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "b", path: [] },
              negated: false,
            },
          ],
        },
        // negation wrapping a generic predicate (not the simplifiable cases)
        {
          type: "negation",
          operand: {
            type: "comparison",
            left: { type: "literal", value: 1 },
            op: "gt",
            right: { type: "literal", value: 0 },
          },
        },
        // opaque
        {
          type: "opaque",
          sourceText: "weirdSync()",
          reason: "unsupportedSyntax",
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
    });
    const filePath = writeTempJson([summary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders every ValueRef and Derivation variant", () => {
    const summary = makeHandlerWith({
      conditions: [
        // derived → propertyAccess
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "dependency", name: "db", accessChain: [] },
            derivation: { type: "propertyAccess", property: "result" },
          },
          op: "eq",
          right: { type: "literal", value: 1 },
        },
        // derived → indexAccess
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "input", inputRef: "arr", path: [] },
            derivation: { type: "indexAccess", index: 0 },
          },
          op: "eq",
          right: { type: "literal", value: "x" },
        },
        // derived → destructured + methodCall + awaited (chained)
        {
          type: "comparison",
          left: {
            type: "derived",
            from: {
              type: "derived",
              from: {
                type: "derived",
                from: { type: "dependency", name: "fetch", accessChain: [] },
                derivation: { type: "awaited" },
              },
              derivation: { type: "methodCall", method: "json", args: [] },
            },
            derivation: { type: "destructured", field: "kind" },
          },
          op: "eq",
          right: { type: "literal", value: "ok" },
        },
        // state ref + unresolved ref
        {
          type: "comparison",
          left: { type: "state", name: "loaded" },
          op: "eq",
          right: { type: "unresolved", sourceText: "MAGIC" },
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
    });
    const filePath = writeTempJson([summary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders every Output variant", () => {
    const summaries: BehavioralSummary[] = [
      // throw
      makeHandlerWith({
        output: {
          type: "throw",
          exceptionType: "ValidationError",
          message: null,
        },
      }),
      // render
      makeHandlerWith({
        output: { type: "render", component: "ErrorPage" },
      }),
      // return
      makeHandlerWith({
        output: { type: "return", value: { type: "text" } },
      }),
      // delegate
      makeHandlerWith({
        output: { type: "delegate", to: "next" },
      }),
      // emit
      makeHandlerWith({
        output: { type: "emit", event: "user.created" },
      }),
      // void
      makeHandlerWith({
        output: { type: "void" },
      }),
    ];
    const filePath = writeTempJson(summaries);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("simplifies double negations and !truthinessCheck via the negation handler", () => {
    const summary = makeHandlerWith({
      conditions: [
        // !!x → x
        {
          type: "negation",
          operand: {
            type: "negation",
            operand: {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "x", path: [] },
              negated: false,
            },
          },
        },
        // !truthinessCheck flips negated
        {
          type: "negation",
          operand: {
            type: "truthinessCheck",
            subject: { type: "input", inputRef: "y", path: [] },
            negated: false,
          },
        },
        // !nullCheck flips negated
        {
          type: "negation",
          operand: {
            type: "nullCheck",
            subject: { type: "input", inputRef: "z", path: [] },
            negated: false,
          },
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
    });
    const filePath = writeTempJson([summary]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });
});
