import { describe, expect, it } from "vitest";

import {
  helperPathsOnVariables,
  mergeReadShapes,
  splitAtHandOffs,
  throughHelper,
} from "./helperHandOff.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { RawBranch, RawCondition, RawTerminal } from "./index.js";

function condition(
  sourceText: string,
  polarity: RawCondition["polarity"],
  source: RawCondition["source"] = "explicit",
): RawCondition {
  return { sourceText, structured: null, polarity, source };
}

function terminal(
  kind: RawTerminal["kind"],
  location: { start: number; end: number },
): RawTerminal {
  return {
    kind,
    statusCode: null,
    body: null,
    exceptionType: kind === "throw" ? "Error" : null,
    message: null,
    component: null,
    location,
  } as RawTerminal;
}

function branch(
  kind: RawTerminal["kind"],
  location: { start: number; end: number },
  conditions: RawCondition[],
  isDefault: boolean,
): RawBranch {
  return {
    conditions,
    terminal: terminal(kind, location),
    effects: [],
    location,
    isDefault,
  };
}

describe("throughHelper", () => {
  const caller = branch("return", { start: 12, end: 12 }, [], true);
  const failed = condition("resp.status >= 400", "positive");
  const helper = [
    branch("throw", { start: 3, end: 3 }, [failed], false),
    branch(
      "return",
      { start: 4, end: 4 },
      [condition("resp.status >= 400", "negative", "earlyReturn")],
      true,
    ),
  ];

  it("ends the caller at the call on a path where the helper throws", () => {
    const [thrown] = throughHelper(caller, { start: 11, end: 11 }, helper);

    expect(thrown?.terminal.kind).toBe("throw");
    expect(thrown?.terminal.exceptionType).toBe("Error");
    expect(thrown?.location).toEqual({ start: 11, end: 11 });
    expect(thrown?.terminal.location).toEqual({ start: 11, end: 11 });
    expect(thrown?.conditions).toEqual([failed]);
    expect(thrown?.isDefault).toBe(false);
  });

  it("goes on to the caller's ending on a path where the helper returns", () => {
    const [, returned] = throughHelper(caller, { start: 11, end: 11 }, helper);

    expect(returned?.terminal).toBe(caller.terminal);
    expect(returned?.location).toEqual(caller.location);
    expect(returned?.conditions.map((c) => c.polarity)).toEqual(["negative"]);
    expect(returned?.isDefault).toBe(true);
  });

  it("keeps the caller's own conditions ahead of the helper's", () => {
    const guarded = branch(
      "return",
      { start: 12, end: 12 },
      [condition("retry", "positive")],
      false,
    );

    const split = throughHelper(guarded, { start: 11, end: 11 }, helper);

    expect(split.map((b) => b.conditions[0]?.sourceText)).toEqual([
      "retry",
      "retry",
    ]);
    expect(split.map((b) => b.isDefault)).toEqual([false, false]);
  });

  it("ends the caller on a helper path that exits the process", () => {
    const [exited] = throughHelper(caller, { start: 11, end: 11 }, [
      branch("exit", { start: 3, end: 3 }, [failed], false),
    ]);

    expect(exited?.terminal.kind).toBe("exit");
    expect(exited?.location).toEqual({ start: 11, end: 11 });
  });
});

describe("mergeReadShapes", () => {
  const unknown = { type: "unknown" } as const;
  const record = (properties: Record<string, TypeShape>): TypeShape => ({
    type: "record",
    properties,
  });

  it("joins the fields two readers read, nested ones included", () => {
    expect(
      mergeReadShapes(
        record({ json: record({ data: unknown }) }),
        record({ json: record({ error: unknown }), status: unknown }),
      ),
    ).toEqual(
      record({
        json: record({ data: unknown, error: unknown }),
        status: unknown,
      }),
    );
  });

  it("keeps whichever side read anything", () => {
    expect(mergeReadShapes(null, record({ a: unknown }))).toEqual(
      record({ a: unknown }),
    );
    expect(mergeReadShapes(record({ a: unknown }), null)).toEqual(
      record({ a: unknown }),
    );
    expect(mergeReadShapes(unknown, record({ a: unknown }))).toEqual(
      record({ a: unknown }),
    );
    expect(mergeReadShapes(null, null)).toBeNull();
  });

  it("gives a split branch the fields its helper read", () => {
    const helper = {
      ...branch("return", { start: 4, end: 4 }, [], true),
      expectedInput: record({ json: record({ data: unknown }) }),
    };
    const [split] = throughHelper(
      { ...branch("return", { start: 12, end: 12 }, [], true) },
      { start: 11, end: 11 },
      [helper],
    );

    expect(split?.expectedInput).toEqual(
      record({ json: record({ data: unknown }) }),
    );
  });
});

describe("splitAtHandOffs", () => {
  const caller = branch("return", { start: 12, end: 12 }, [], true);
  const helper = [
    branch(
      "throw",
      { start: 3, end: 3 },
      [condition("bad", "positive")],
      false,
    ),
  ];
  const guard = [
    branch(
      "throw",
      { start: 3, end: 3 },
      [condition("bad", "positive")],
      false,
    ),
    branch(
      "return",
      { start: 4, end: 4 },
      [condition("bad", "negative")],
      true,
    ),
  ];
  const site = (paths: RawBranch[], line: number) => ({
    helper: paths,
    line,
    at: { start: line, end: line },
  });

  it("splits at a hand-off on the branch", () => {
    const split = splitAtHandOffs(caller, [site(helper, 11)]);

    expect(split).toHaveLength(1);
    expect(split[0]?.location).toEqual({ start: 11, end: 11 });
  });

  it("goes on to the next hand-off on a path the first helper returned on", () => {
    const split = splitAtHandOffs(caller, [site(guard, 10), site(guard, 11)]);

    expect(
      split.map((path) => `${path.terminal.kind}@${path.location.start}`),
    ).toEqual(["throw@10", "throw@11", "return@12"]);
  });

  it("skips a call written after the branch ends, or under a guard the branch ruled out", () => {
    const guarded = {
      ...site(helper, 11),
      preconditions: [condition("retry", "positive")],
    };
    const split = splitAtHandOffs(caller, [site(helper, 13), guarded]);
    const guardedOut = splitAtHandOffs(
      branch(
        "return",
        { start: 12, end: 12 },
        [condition("retry", "negative")],
        false,
      ),
      [guarded],
    );

    expect(split[0]?.location).toEqual({ start: 11, end: 11 });
    expect(guardedOut).toHaveLength(1);
    expect(guardedOut[0]?.terminal.kind).toBe("return");
  });

  it("counts a call in a finally block on a branch that ended before it", () => {
    const split = splitAtHandOffs(caller, [
      { ...site(helper, 14), alwaysRuns: true },
    ]);

    expect(split[0]?.terminal.kind).toBe("throw");
  });
});

describe("helperPathsOnVariables", () => {
  const onParameter = (path: string[]): RawCondition => ({
    ...condition("resp.status >= 400", "positive"),
    structured: {
      type: "comparison",
      left: { type: "input", inputRef: "resp", path },
      op: "gte",
      right: { type: "literal", value: 400 },
    },
  });

  it("writes the helper's test on its parameter as a test on the caller's variable", () => {
    const paths = helperPathsOnVariables(
      [branch("throw", { start: 3, end: 3 }, [onParameter(["status"])], false)],
      new Map([["resp", "response"]]),
    );

    expect(paths?.[0]?.conditions[0]?.structured).toEqual({
      type: "comparison",
      left: { type: "dependency", name: "response", accessChain: ["status"] },
      op: "gte",
      right: { type: "literal", value: 400 },
    });
  });

  it("renames a parameter the helper reads as a dependency, through a derived read", () => {
    const derived: RawCondition = {
      ...condition("resp.ok", "positive"),
      structured: {
        type: "truthinessCheck",
        subject: {
          type: "derived",
          from: { type: "dependency", name: "resp", accessChain: [] },
          derivation: { type: "propertyAccess", property: "ok" },
        },
        negated: false,
      },
    };

    const paths = helperPathsOnVariables(
      [branch("throw", { start: 3, end: 3 }, [derived], false)],
      new Map([["resp", "response"]]),
    );

    expect(JSON.stringify(paths?.[0]?.conditions)).toContain(
      '"name":"response"',
    );
  });

  it("follows no helper that never tests what it was handed", () => {
    const other: RawCondition = {
      ...condition("label", "positive"),
      structured: {
        type: "truthinessCheck",
        subject: { type: "input", inputRef: "label", path: [] },
        negated: false,
      },
    };

    expect(
      helperPathsOnVariables(
        [
          branch("throw", { start: 3, end: 3 }, [other], false),
          branch(
            "return",
            { start: 4, end: 4 },
            [condition("x", "negative")],
            true,
          ),
        ],
        new Map([["resp", "response"]]),
      ),
    ).toBeNull();
  });

  it("follows no helper with more paths than a caller can take on", () => {
    const many = Array.from({ length: 17 }, (_, line) =>
      branch(
        "throw",
        { start: line, end: line },
        [onParameter(["status"])],
        false,
      ),
    );

    expect(
      helperPathsOnVariables(many, new Map([["resp", "response"]])),
    ).toBeNull();
  });
});
