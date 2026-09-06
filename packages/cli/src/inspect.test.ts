import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  restBinding,
  unitInvocationBinding,
  withWrapperMetadata,
} from "@suss/behavioral-ir";

import { formatCondition, inspect, inspectDiff } from "./inspect.js";
import { runCli } from "./run.js";

import type {
  BehavioralSummary,
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
      expect(output).toContain("removed handler");
      expect(() => JSON.parse(output)).toThrow();
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
      expect(output).toContain("(effects changed)");
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
      expect(output).toContain("1 change\n");
      expect(output).toContain("~ 200\n");
      expect(output).toContain("-> 200  when  !(name.length > 64)");
      expect(output).not.toContain("(default)");
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
