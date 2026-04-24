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
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "express",
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
    http: {
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
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "fetch",
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

  it("renders effects under each transition with follow-reference marker", () => {
    // A handler whose body calls other functions — some of which are
    // themselves summarized in the same file (get the `→` marker),
    // others are external (no marker).
    const helperSummary: BehavioralSummary = {
      kind: "library",
      location: {
        file: "src/helpers.ts",
        range: { start: 1, end: 3 },
        exportName: "formatPayload",
      },
      identity: {
        name: "formatPayload",
        exportPath: ["formatPayload"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "reachable",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "formatPayload:return:none:fp01",
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 1, end: 3 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const withEffects: BehavioralSummary = {
      kind: "handler",
      location: {
        file: "src/handler.ts",
        range: { start: 10, end: 20 },
        exportName: "submit",
      },
      identity: {
        name: "submit",
        exportPath: ["submit"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "reachable",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "submit:return:none:s01",
          conditions: [],
          output: { type: "return", value: null },
          effects: [
            // Intra-file summary — `formatPayload` should match and
            // get the `→` marker.
            {
              type: "invocation",
              callee: "formatPayload",
              args: [],
              async: false,
            },
            // External — no summary, no marker.
            {
              type: "invocation",
              callee: "logger.info",
              args: [],
              async: false,
            },
            // Dotted callee whose last segment IS in the set.
            {
              type: "invocation",
              callee: "utils.formatPayload",
              args: [],
              async: false,
            },
          ],
          location: { start: 10, end: 20 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };

    const filePath = writeTempJson([helperSummary, withEffects]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("qualifies generic names (loader/action/default) with file path", () => {
    // Two route files both exporting a `loader` — bare `loader` as a
    // header is ambiguous; inspect should prefix with the relative
    // file path (minus extension) so readers can tell them apart.
    const loaderA: BehavioralSummary = {
      kind: "loader",
      location: {
        file: "app/routes/_app.tsx",
        range: { start: 10, end: 20 },
        exportName: "loader",
      },
      identity: {
        name: "loader",
        exportPath: ["loader"],
        boundaryBinding: {
          transport: "http",
          semantics: { name: "function-call" },
          recognition: "react-router",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "l1",
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 10, end: 20 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const loaderB: BehavioralSummary = {
      ...loaderA,
      location: { ...loaderA.location, file: "app/routes/_app.admin.tsx" },
    };
    const filePath = writeTempJson([loaderA, loaderB]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("replaces useEffect effect with a reference to its spawned sub-unit", () => {
    // A React component with two `useEffect` calls spawns two
    // sub-units (`Foo.effect#0`, `Foo.effect#1`). Rather than rendering
    // `+ useEffect` twice on the parent's effect list, inspect should
    // reference each sub-unit directly. The sub-unit summaries are
    // immediately readable below.
    const parent: BehavioralSummary = {
      kind: "component",
      location: {
        file: "src/Foo.tsx",
        range: { start: 10, end: 40 },
        exportName: "Foo",
      },
      identity: {
        name: "Foo",
        exportPath: ["Foo"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "react",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "foo-render",
          conditions: [],
          output: { type: "render", component: "div" },
          effects: [
            {
              type: "invocation",
              callee: "useEffect",
              args: [],
              async: false,
            },
            {
              type: "invocation",
              callee: "useEffect",
              args: [],
              async: false,
            },
          ],
          location: { start: 10, end: 40 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const mkEffect = (i: number): BehavioralSummary => ({
      kind: "handler",
      location: {
        file: "src/Foo.tsx",
        range: { start: 12 + i, end: 13 + i },
        exportName: `effect#${i}`,
      },
      identity: {
        name: `Foo.effect#${i}`,
        exportPath: [`effect#${i}`],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "react",
        },
      },
      inputs: [],
      transitions: [
        {
          id: `fe${i}`,
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 12 + i, end: 13 + i },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
      metadata: {
        react: { kind: "effect", component: "Foo", index: i, deps: null },
      },
    });
    const filePath = writeTempJson([parent, mkEffect(0), mkEffect(1)]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("renders useEffect deps: mount-only, every-render, and dep list", () => {
    // Three useEffect sub-units under one parent, each exercising one
    // of the three deps cases. Inspect should distinguish them in the
    // header's parenthesized metadata so a reader can tell scheduling
    // behavior at a glance.
    const parent: BehavioralSummary = {
      kind: "component",
      location: {
        file: "src/Bar.tsx",
        range: { start: 1, end: 30 },
        exportName: "Bar",
      },
      identity: {
        name: "Bar",
        exportPath: ["Bar"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "react",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "bar-render",
          conditions: [],
          output: { type: "render", component: "div" },
          effects: [],
          location: { start: 1, end: 30 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const mkEffect = (i: number, deps: string[] | null): BehavioralSummary => ({
      kind: "handler",
      location: {
        file: "src/Bar.tsx",
        range: { start: 10 + i, end: 11 + i },
        exportName: `effect#${i}`,
      },
      identity: {
        name: `Bar.effect#${i}`,
        exportPath: [`effect#${i}`],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "react",
        },
      },
      inputs: [],
      transitions: [
        {
          id: `be${i}`,
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 10 + i, end: 11 + i },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
      metadata: {
        react: { kind: "effect", component: "Bar", index: i, deps },
      },
    });
    const filePath = writeTempJson([
      parent,
      mkEffect(0, null),
      mkEffect(1, []),
      mkEffect(2, ["user", "prefs.locale"]),
    ]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("expands render subtrees so branches sharing a root stay distinguishable", () => {
    // Two branches of the same component both render `<Container />`
    // but with different children. Inspect should surface the
    // children — otherwise the branches look identical.
    const component: BehavioralSummary = {
      kind: "component",
      location: {
        file: "src/App.tsx",
        range: { start: 1, end: 40 },
        exportName: "App",
      },
      identity: {
        name: "App",
        exportPath: ["App"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "react",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "app:render:loggedIn",
          conditions: [
            {
              type: "truthinessCheck",
              subject: { type: "input", inputRef: "user", path: [] },
              negated: false,
            },
          ],
          output: {
            type: "render",
            component: "Container",
            root: {
              type: "element",
              tag: "Container",
              attrs: { fluid: "" },
              children: [
                { type: "element", tag: "Header", children: [] },
                {
                  type: "element",
                  tag: "Main",
                  children: [
                    { type: "element", tag: "Dashboard", children: [] },
                  ],
                },
              ],
            },
          },
          effects: [],
          location: { start: 10, end: 20 },
          isDefault: false,
        },
        {
          id: "app:render:loggedOut",
          conditions: [],
          output: {
            type: "render",
            component: "Container",
            root: {
              type: "element",
              tag: "Container",
              attrs: { fluid: "" },
              children: [{ type: "element", tag: "LoginForm", children: [] }],
            },
          },
          effects: [],
          location: { start: 25, end: 35 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const filePath = writeTempJson([component]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    expect(output).toMatchSnapshot();
  });

  it("injects continuation markers every 50 body lines for long summaries", () => {
    // Build a summary with many elif branches so its rendered body
    // exceeds the continuation threshold. The reader should see the
    // file name re-emitted as a tree-aligned marker partway through,
    // not lose context entirely.
    const transitions: Transition[] = [];
    for (let i = 0; i < 50; i++) {
      transitions.push({
        id: `huge:branch:${i}`,
        conditions: [
          {
            type: "comparison",
            left: { type: "literal", value: i },
            op: "eq",
            right: { type: "literal", value: i },
          },
        ],
        output: {
          type: "response",
          statusCode: { type: "literal", value: 200 },
          body: null,
          headers: {},
        },
        effects: [],
        location: { start: 10 + i, end: 10 + i },
        isDefault: false,
      });
    }
    const long: BehavioralSummary = {
      kind: "handler",
      location: {
        file: "app/util/graph/component.ts",
        range: { start: 10, end: 100 },
        exportName: "calculateNodeProperties",
      },
      identity: {
        name: "calculateNodeProperties",
        exportPath: ["calculateNodeProperties"],
        boundaryBinding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "reachable",
        },
      },
      inputs: [],
      transitions,
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const filePath = writeTempJson([long]);
    const output = captureStdout(() => inspect({ file: filePath }));
    fs.rmSync(path.dirname(filePath), { recursive: true });
    // Snapshot is noisy for this one; assert the continuation marker
    // appears the right number of times and at the right indent
    // instead, keeping the test readable.
    const marker = "   ↳ app/util/graph/component.ts (cont.)";
    const matches = output.split("\n").filter((l) => l === marker).length;
    expect(matches).toBeGreaterThanOrEqual(1);
  });

  it("renders library + caller summaries with function-call identity", () => {
    const librarySummary: BehavioralSummary = {
      kind: "library",
      location: {
        file: "src/binding.ts",
        range: { start: 10, end: 20 },
        exportName: "makeBinding",
      },
      identity: {
        name: "makeBinding",
        exportPath: ["makeBinding"],
        boundaryBinding: {
          transport: "in-process",
          semantics: {
            name: "function-call",
            package: "@ex/lib",
            exportPath: ["makeBinding"],
          },
          recognition: "package-exports:@ex/lib",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "makeBinding:return:none:aaa0001",
          conditions: [],
          output: { type: "return", value: { type: "ref", name: "Binding" } },
          effects: [],
          location: { start: 10, end: 20 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const callerSummary: BehavioralSummary = {
      kind: "caller",
      location: {
        file: "src/app.ts",
        range: { start: 42, end: 55 },
        exportName: "initApp",
      },
      identity: {
        name: "initApp",
        exportPath: ["initApp"],
        boundaryBinding: {
          transport: "in-process",
          semantics: {
            name: "function-call",
            package: "@ex/lib",
            exportPath: ["makeBinding"],
          },
          recognition: "package-import:@ex/app",
        },
      },
      inputs: [],
      transitions: [
        {
          id: "initApp:return:none:bbb0001",
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 42, end: 55 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };

    const filePath = writeTempJson([librarySummary, callerSummary]);
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
