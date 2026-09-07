import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  restBinding,
  storageBinding,
  unitInvocationBinding,
  withWrapperMetadata,
} from "@suss/behavioral-ir";

import { formatCondition, inspect, inspectDiff } from "./inspect.js";
import { runCli } from "./run.js";

import type {
  BehavioralSummary,
  Effect,
  Transition,
  ValueRef,
  WrapperMetadata,
} from "@suss/behavioral-ir";

/** The smallest summary a diff has something to say about. */
function routeSummary(name: string, routePath: string): BehavioralSummary {
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
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "test",
        method: "GET",
        path: routePath,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** What a call wrote to stdout, and what it returned. */
function captureStdout<T>(run: () => T): { output: string; result: T } {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: run(), output: written.join("") };
  } finally {
    process.stdout.write = original;
  }
}

describe("inspect --diff --json", () => {
  const withFiles = (
    before: BehavioralSummary[],
    after: BehavioralSummary[],
    run: (paths: { before: string; after: string }) => void,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-diffjson-"));
    const beforePath = path.join(dir, "before.json");
    const afterPath = path.join(dir, "after.json");
    fs.writeFileSync(beforePath, JSON.stringify(before));
    fs.writeFileSync(afterPath, JSON.stringify(after));
    try {
      run({ before: beforePath, after: afterPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("says which summaries were removed", () => {
    // The summaries a diff reads are already JSON, and the diff itself
    // is worked out from two of them, so a machine has nowhere else to
    // get it.
    withFiles([routeSummary("getUser", "/users/:id")], [], (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        version: number;
        changed: number;
        summaries: Array<{ change: string; kind: string }>;
      };

      expect(parsed.version).toBe(1);
      expect(parsed.changed).toBe(1);
      expect(parsed.summaries[0]?.change).toBe("removed");
      expect(parsed.summaries[0]?.kind).toBe("handler");
    });
  });

  it("says which were added", () => {
    withFiles([], [routeSummary("getUser", "/users/:id")], (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ change: string }>;
      };
      expect(parsed.summaries[0]?.change).toBe("added");
    });
  });

  it("leaves out a summary that did not move", () => {
    // A consumer wants what changed. Printing every unchanged boundary
    // beside it buries that.
    const same = [routeSummary("getUser", "/users/:id")];
    withFiles(same, same, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as { changed: number };
      expect(parsed.changed).toBe(0);
    });
  });

  it("prints for a person when nobody asked for JSON", () => {
    withFiles([routeSummary("getUser", "/users/:id")], [], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("- serves GET /users/{id}");
      expect(() => JSON.parse(output)).toThrow();
    });
  });

  it("keeps every caller of one route apart", () => {
    // Three callers of GET /pet/{id} share a boundary key. Keying the
    // diff on that alone kept one of them and dropped the other two,
    // so a change to a dropped caller printed as no change at all.
    const caller = (name: string, file: string): BehavioralSummary => ({
      ...routeSummary(name, "/pet/{id}"),
      kind: "client",
      location: {
        file,
        range: { start: 1, end: 20 },
        exportName: name,
      },
    });
    const withReturn = (s: BehavioralSummary): BehavioralSummary => ({
      ...s,
      transitions: [
        {
          id: `${s.identity.name}:return:none:1`,
          conditions: [],
          output: { type: "return", value: null },
          effects: [],
          location: { start: 1, end: 5 },
          isDefault: true,
        },
      ],
    });
    const before = [
      caller("getPet", "src/a.ts"),
      caller("safeGetPet", "src/a.ts"),
      caller("describePet", "src/a.ts"),
    ];
    const after = [
      withReturn(caller("getPet", "src/a.ts")),
      caller("safeGetPet", "src/a.ts"),
      caller("listPets", "src/a.ts"),
    ];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ key: string; change: string }>;
      };
      const byKey = Object.fromEntries(
        parsed.summaries.map((s) => [s.key, s.change]),
      );
      expect(byKey).toEqual({
        "client:GET /pet/{id}::getPet": "changed",
        "client:GET /pet/{id}::describePet": "removed",
        "client:GET /pet/{id}::listPets": "added",
      });
    });
  });

  it("tells two same-named callers apart by file", () => {
    const caller = (file: string): BehavioralSummary => ({
      ...routeSummary("load", "/pet/{id}"),
      kind: "client",
      location: { file, range: { start: 1, end: 20 }, exportName: "load" },
    });
    const before = [caller("src/a.ts"), caller("src/b.ts")];
    const after = [caller("src/a.ts")];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ key: string; change: string }>;
      };
      expect(parsed.summaries).toEqual([
        expect.objectContaining({
          key: "client:GET /pet/{id}::src/b.ts::load",
          change: "removed",
        }),
      ]);
    });
  });

  it("tells two same-named libraries apart by file", () => {
    // Three repository classes each have a `list` method. Keyed by name
    // alone, the diff used to keep one of them and drop the rest.
    const library = (file: string): BehavioralSummary => ({
      ...routeSummary("list", "/unused"),
      kind: "library",
      location: { file, range: { start: 1, end: 20 }, exportName: "list" },
      identity: { name: "list", exportPath: ["list"], boundaryBinding: null },
    });
    const before = [library("src/users.ts"), library("src/teams.ts")];
    const after = [library("src/users.ts"), library("src/invitations.ts")];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ key: string; change: string }>;
      };
      expect(parsed.summaries).toEqual([
        expect.objectContaining({
          key: "library::src/invitations.ts::list",
          change: "added",
        }),
        expect.objectContaining({
          key: "library::src/teams.ts::list",
          change: "removed",
        }),
      ]);
    });
  });

  it("pairs a renamed handler by its route and a renamed caller by its name", () => {
    // A handler is usually an anonymous callback, so the route is the
    // only identity it keeps across a rename. A caller has a name of
    // its own, and the same rename is a unit leaving and one arriving.
    const caller = (name: string): BehavioralSummary => ({
      ...routeSummary(name, "/pet/{id}"),
      kind: "client",
    });
    const before = [routeSummary("getUser", "/users/:id"), caller("getPet")];
    const after = [routeSummary("readUser", "/users/:id"), caller("fetchPet")];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ key: string; change: string }>;
      };
      const byKey = Object.fromEntries(
        parsed.summaries.map((s) => [s.key, s.change]),
      );
      expect(byKey).toEqual({
        "client:GET /pet/{id}::getPet": "removed",
        "client:GET /pet/{id}::fetchPet": "added",
      });
    });
  });
});

describe("inspect, a route the wrappers cover", () => {
  const withSummaries = (
    summaries: BehavioralSummary[],
    run: (file: string) => void,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-wrappers-"));
    const file = path.join(dir, "api.json");
    fs.writeFileSync(file, JSON.stringify(summaries));
    try {
      run(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const wrapped = (applied: WrapperMetadata["applied"]): BehavioralSummary => ({
    ...routeSummary("getUser", "/users/:id"),
    metadata: withWrapperMetadata(undefined, { applied }),
  });

  it("points at each wrapper, with the scope the registration gave it", () => {
    withSummaries(
      [
        wrapped([
          { file: "src/requireCaller.ts", name: "requireCaller", scope: "/v1" },
        ]),
      ],
      (file) => {
        const { output } = captureStdout(() => inspect({ file }));
        expect(output).toContain(
          "wrapped by requireCaller (src/requireCaller.ts) for /v1",
        );
      },
    );
  });

  it("says which wrapper only runs when the route throws", () => {
    withSummaries(
      [wrapped([{ file: "src/app.ts", name: "onError", onThrow: true }])],
      (file) => {
        const { output } = captureStdout(() => inspect({ file }));
        expect(output).toContain("wrapped by onError (src/app.ts) on a throw");
      },
    );
  });

  it("says which wrapper produced an outcome the route's own body does not", () => {
    const route = wrapped([
      { file: "src/requireCaller.ts", name: "requireCaller" },
    ]);
    withSummaries(
      [
        {
          ...route,
          transitions: [
            {
              id: "denied",
              conditions: [],
              output: {
                type: "response",
                statusCode: { type: "literal", value: 401 },
                body: null,
                headers: {},
              },
              effects: [],
              location: { start: 3, end: 3 },
              isDefault: false,
              metadata: withWrapperMetadata(undefined, {
                from: { file: "src/requireCaller.ts", name: "requireCaller" },
              }),
            },
          ],
        },
      ],
      (file) => {
        const { output } = captureStdout(() => inspect({ file }));
        expect(output).toContain("-> 401  (from requireCaller)");
      },
    );
  });

  it("counts the wrappers it has no room to list", () => {
    withSummaries(
      [
        wrapped([
          { file: "src/a.ts", name: "a" },
          { file: "src/b.ts", name: "b" },
          { file: "src/c.ts", name: "c" },
          { file: "src/d.ts", name: "d" },
        ]),
      ],
      (file) => {
        const { output } = captureStdout(() => inspect({ file }));
        expect(output).toContain("+1 more");
        expect(output).not.toContain("src/d.ts");
      },
    );
  });
});

describe("which inspect forms take --json", () => {
  const quietly = async (args: string[]): Promise<number> => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return await runCli(args);
    } finally {
      process.stderr.write = original;
    }
  };

  it("refuses it for a plain read, and says where to get JSON", async () => {
    // The file inspect reads is already JSON, so printing it again
    // helps nobody. A diff is worked out from two files and lives in
    // neither, which is why that form takes the flag.
    expect(await quietly(["inspect", "summaries.json", "--json"])).toBe(1);
  });

  it("refuses it for --dir, which used to drop it without a word", async () => {
    expect(await quietly(["inspect", "--dir", "summaries/", "--json"])).toBe(1);
  });
});

describe("inspect --diff, human output", () => {
  const withFiles = (
    before: BehavioralSummary[],
    after: BehavioralSummary[],
    run: (paths: { before: string; after: string }) => void,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-diffhuman-"));
    const beforePath = path.join(dir, "before.json");
    const afterPath = path.join(dir, "after.json");
    fs.writeFileSync(beforePath, JSON.stringify(before));
    fs.writeFileSync(afterPath, JSON.stringify(after));
    try {
      run({ before: beforePath, after: afterPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const respondsWith = (
    name: string,
    routePath: string,
    transition: Partial<Transition>,
  ): BehavioralSummary => ({
    ...routeSummary(name, routePath),
    transitions: [
      {
        id: "t1",
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
        ...transition,
      },
    ],
  });

  /** The same unit, moved to a file of its own. */
  const inFile = (s: BehavioralSummary, file: string): BehavioralSummary => ({
    ...s,
    location: { ...s.location, file },
  });

  const changedTo = (
    name: string,
    file: string,
    status: number,
  ): BehavioralSummary =>
    inFile(
      respondsWith(name, `/${name}`, {
        output: {
          type: "response",
          statusCode: { type: "literal", value: status },
          body: null,
          headers: {},
        },
      }),
      file,
    );

  it("groups the units under the file they are in", () => {
    const before = [
      changedTo("getUser", "src/users.ts", 200),
      changedTo("getTeam", "src/teams.ts", 200),
    ];
    const after = [
      changedTo("getUser", "src/users.ts", 201),
      changedTo("getTeam", "src/teams.ts", 202),
    ];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("src/teams.ts\n  ~ getTeam");
      expect(output).toContain("src/users.ts\n  ~ getUser");
      expect(output.indexOf("src/teams.ts")).toBeLessThan(
        output.indexOf("src/users.ts"),
      );
    });
  });

  it("puts the files the change did not touch first", () => {
    // A unit that moved without its own file moving is the one a
    // reviewer has no other way to find.
    const before = [
      changedTo("getUser", "src/users.ts", 200),
      changedTo("getTeam", "src/teams.ts", 200),
    ];
    const after = [
      changedTo("getUser", "src/users.ts", 201),
      changedTo("getTeam", "src/teams.ts", 202),
    ];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, changedFiles: ["src/teams.ts"] }),
      );
      const byFile = output.slice(output.indexOf("Changes by file"));
      expect(byFile.indexOf("src/users.ts")).toBeLessThan(
        byFile.indexOf("src/teams.ts"),
      );
      expect(output).toContain("src/teams.ts  (changed in this pull request)");
    });
  });

  it("names the units in a file and leaves the detail to that file's diff", () => {
    const before = [changedTo("getTeam", "src/teams.ts", 200)];
    const after = [changedTo("getTeam", "src/teams.ts", 202)];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, changedFiles: ["src/teams.ts"] }),
      );
      const byFile = output.slice(output.indexOf("Changes by file"));
      expect(byFile).toContain("src/teams.ts  (changed in this pull request)");
      expect(byFile).toContain("~ getTeam");
      expect(byFile).not.toContain("-> 202");
    });
  });

  it("stops at the budget and counts what it left out", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const before = files.map((f, i) => changedTo(`unit${i}`, f, 200));
    const after = files.map((f, i) => changedTo(`unit${i}`, f, 201));

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, budget: 400 }),
      );
      expect(output.length).toBeLessThan(700);
      expect(output).toMatch(/\.\.\. \d+ more boundaries/);
    });
  });

  it("counts one left-out file in the singular", () => {
    const before = [
      changedTo("first", "src/first.ts", 200),
      changedTo("second", "src/second.ts", 200),
    ];
    const after = [
      changedTo("first", "src/first.ts", 201),
      changedTo("second", "src/second.ts", 201),
    ];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, budget: 60 }),
      );
      expect(output).toContain("1 more boundary");
    });
  });

  it("marks a unit that was added or removed under the file it was in", () => {
    const before = [changedTo("gone", "src/gone.ts", 200)];
    const after = [changedTo("fresh", "src/fresh.ts", 200)];

    withFiles(before, after, (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("+ serves GET /fresh  src/fresh.ts::fresh");
      expect(output).toContain("- serves GET /gone  src/gone.ts::gone");
      expect(output).toContain("src/fresh.ts\n  + fresh");
      expect(output).toContain("src/gone.ts\n  - gone");
    });
  });

  it("says which field moved when the two lines read the same", () => {
    // The short line says the output and the conditions. A change to
    // anything else printed as one line twice, and a reader gating a
    // review on the diff could not tell what moved.
    const before = respondsWith("getUser", "/users/:id", {});
    const after = respondsWith("getUser", "/users/:id", {
      effects: [{ type: "stateChange", variable: "auditCount" }],
    });

    withFiles([before], [after], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain(
        'effects: [] -> [{"type":"stateChange","variable":"auditCount"}]',
      );
    });
  });

  it("spells out the guard of a fall-through whose guard is what changed", () => {
    // A new guard in front of the fall-through gives it a new id. Matched
    // by id, that printed as the same "(default)" line removed and added.
    const before = respondsWith("createUser", "/users", { id: "t1" });
    const after = respondsWith("createUser", "/users", {
      id: "t2",
      conditions: [
        {
          type: "negation",
          operand: {
            type: "comparison",
            left: { type: "unresolved", sourceText: "name.length" },
            op: "gt",
            right: { type: "literal", value: 64 },
          },
        },
      ],
    });

    withFiles([before], [after], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("~ 200\n");
      expect(output).toContain("-> 200  when  !(name.length > 64)");
      expect(output).not.toContain("(default)");
    });
  });

  /** A function in the middle of the project, calling the next one along. */
  const link = (
    name: string,
    calls: string | null,
    effects: Effect[] = [],
  ): BehavioralSummary => ({
    kind: "library",
    location: {
      file: `src/${name}.ts`,
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: null,
      id: `test::src/${name}.ts::${name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          ...(calls === null
            ? []
            : [
                {
                  type: "invocation" as const,
                  callee: calls,
                  args: [],
                  async: true,
                  summary: `test::src/${calls}.ts::${calls}`,
                },
              ]),
          ...effects,
        ],
        location: { start: 2, end: 8 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  });

  const READS_ORDERS: Effect = {
    type: "interaction",
    binding: storageBinding({
      recognition: "aws-dynamodb-query",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "orders",
    }),
    callee: "docClient.query",
    interaction: {
      class: "storage-access",
      kind: "read",
      fields: ["orderId"],
      selector: ["orderId"],
      operation: "query",
    },
  };

  /** A route that calls `first`, and a chain of that many functions after it. */
  const chain = (length: number, tail: Effect[]): BehavioralSummary[] => {
    const names = Array.from({ length }, (_, i) => `hop${i}`);
    const handler: BehavioralSummary = {
      ...routeSummary("show", "/orders/:id"),
      transitions: [
        {
          id: "show:200",
          conditions: [],
          output: {
            type: "response",
            statusCode: { type: "literal", value: 200 },
            body: null,
            headers: {},
          },
          effects: [
            {
              type: "invocation",
              callee: "hop0",
              args: [],
              async: true,
              summary: "test::src/hop0.ts::hop0",
            },
          ],
          location: { start: 2, end: 8 },
          isDefault: true,
        },
      ],
      identity: {
        ...routeSummary("show", "/orders/:id").identity,
        id: "test::src/handlers/show.ts::show",
      },
    };
    return [
      handler,
      ...names.map((name, i) =>
        link(name, names[i + 1] ?? null, i === length - 1 ? tail : []),
      ),
    ];
  };

  it("reports the table a route now reads, and the calls it takes to reach it", () => {
    withFiles(chain(1, []), chain(1, [READS_ORDERS]), (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("+ reads aws.dynamodb:orders  through hop0");
    });
  });

  it("collapses the middle of a long chain and counts what it skipped", () => {
    withFiles(chain(4, []), chain(4, [READS_ORDERS]), (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain(
        "through hop0 -> (2 intermediate units collapsed) -> hop3",
      );
    });
  });

  it("prints every call when the reader asks for the whole chain", () => {
    withFiles(chain(4, []), chain(4, [READS_ORDERS]), (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, chain: "full" }),
      );
      expect(output).toContain("through hop0 -> hop1 -> hop2 -> hop3");
    });
  });

  it("prints no chain at all when the reader asks for none", () => {
    withFiles(chain(4, []), chain(4, [READS_ORDERS]), (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, chain: 0 }),
      );
      expect(output).toContain("+ reads aws.dynamodb:orders\n");
      expect(output).not.toContain("through");
    });
  });

  it("cuts a ref whose name is the whole printed type", () => {
    // A type the adapter cannot name comes through as the compiler's
    // printed text, thousands of characters for an inferred alias, and
    // the diff put all of it on one line.
    const wide = `Map<string, { ${Array.from({ length: 60 }, (_, i) => `field${i}: string`).join("; ")} }>`;
    const before = respondsWith("listUsers", "/users", {});
    const after = respondsWith("listUsers", "/users", {
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: { type: "ref", name: wide },
        headers: {},
      },
    });

    withFiles([before], [after], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      const line = output
        .split("\n")
        .find((l) => l.includes("-> 200 Map<string"));
      expect(line).toBeDefined();
      expect(line?.length).toBeLessThan(160);
      expect(line).toMatch(/\.\.\.\s+\(default\)$/);
    });
  });

  it("stays quiet about a transition that only moved in the file", () => {
    const before = respondsWith("getUser", "/users/:id", {});
    const after = respondsWith("getUser", "/users/:id", {
      location: { start: 41, end: 45 },
    });

    withFiles([before], [after], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("No behavioral changes.");
    });
  });
});

describe("formatCondition", () => {
  const id: ValueRef = {
    type: "input",
    inputRef: "request.params.id",
    path: [],
  };

  it("takes a double negation back off", () => {
    expect(
      formatCondition({
        type: "negation",
        operand: {
          type: "negation",
          operand: { type: "truthinessCheck", subject: id, negated: false },
        },
      }),
    ).toBe("request.params.id");
  });

  it("flips a truthiness or null check rather than wrapping it", () => {
    expect(
      formatCondition({
        type: "negation",
        operand: { type: "truthinessCheck", subject: id, negated: false },
      }),
    ).toBe("!request.params.id");
    expect(
      formatCondition({
        type: "negation",
        operand: { type: "nullCheck", subject: id, negated: false },
      }),
    ).toBe("request.params.id != null");
  });

  it("wraps anything else it cannot flip", () => {
    expect(
      formatCondition({
        type: "negation",
        operand: {
          type: "comparison",
          left: id,
          op: "eq",
          right: { type: "literal", value: "x" },
        },
      }),
    ).toBe('!(request.params.id === "x")');
  });

  it("writes a call, a property check and a compound as the code has them", () => {
    expect(
      formatCondition({ type: "call", callee: "isAdmin", args: [id] }),
    ).toBe("isAdmin(request.params.id)");
    expect(
      formatCondition({
        type: "propertyExists",
        subject: id,
        property: "role",
        negated: true,
      }),
    ).toBe('!request.params.id.has("role")');
    expect(
      formatCondition({
        type: "compound",
        op: "or",
        operands: [
          { type: "truthinessCheck", subject: id, negated: false },
          { type: "truthinessCheck", subject: id, negated: true },
        ],
      }),
    ).toBe("request.params.id || !request.params.id");
  });
});

describe("a Lambda the template declares no trigger for", () => {
  const lambdaSummary = (eventTypes: string[]): BehavioralSummary => ({
    kind: "handler",
    location: {
      file: "src/worker.ts",
      range: { start: 1, end: 5 },
      exportName: "handler",
    },
    identity: {
      name: "OrphanFunction.handler",
      exportPath: ["OrphanFunction.handler"],
      boundaryBinding: unitInvocationBinding({
        recognition: "aws-lambda",
        deploymentTarget: "lambda",
        instanceName: "OrphanFunction",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: {
      awsLambda: {
        handler: "src/worker.handler",
        recognition: "recognized-not-http",
        eventTypes,
      },
    },
  });

  /** A caller whose one effect invokes the function it is given. */
  const invokerSummary = (instanceName: string | null): BehavioralSummary => ({
    kind: "handler",
    location: {
      file: "src/caller.ts",
      range: { start: 1, end: 5 },
      exportName: "handler",
    },
    identity: {
      name: "CallerFunction.handler",
      exportPath: ["CallerFunction.handler"],
      boundaryBinding: unitInvocationBinding({
        recognition: "aws-lambda",
        deploymentTarget: "lambda",
        instanceName: "CallerFunction",
      }),
    },
    inputs: [],
    transitions: [
      {
        id: "t0",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: unitInvocationBinding({
              recognition: "aws-lambda",
              deploymentTarget: "lambda",
              instanceName,
            }),
            callee: "lambda.send",
            interaction: { class: "unit-invoke" },
          },
        ],
        location: { start: 1, end: 5 },
        isDefault: false,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: {},
  });

  const inspectAll = (summaries: BehavioralSummary[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-trigger-"));
    const file = path.join(dir, "code.json");
    fs.writeFileSync(file, JSON.stringify(summaries));
    return captureStdout(() => inspect({ file })).output;
  };

  it("says nothing in the run invokes it", () => {
    const output = inspectAll([lambdaSummary([])]);

    expect(output).toContain("Nothing in the template routes an event here");
    expect(output).toContain("outside what suss read");
  });

  it("names the function that invokes it", () => {
    const output = inspectAll([
      lambdaSummary([]),
      invokerSummary("OrphanFunction"),
    ]);

    expect(output).toContain("It is invoked by CallerFunction.handler");
  });

  it("says an invoke that settles its target at run time could reach it", () => {
    const output = inspectAll([lambdaSummary([]), invokerSummary(null)]);

    expect(output).toContain("with 1 invoke here working out the target");
  });

  it("stays quiet when an event reaches it", () => {
    const output = inspectAll([lambdaSummary(["SQS"])]);

    expect(output).not.toContain("Nothing in the template");
  });
});
