import { describe, expect, it } from "vitest";

import { SharedValueReader, sharedSummaryLines } from "./sharedValues.js";

const written = (summaries: unknown[]): string[] => [
  ...sharedSummaryLines(summaries),
];

const readBack = (lines: string[]): unknown[] => {
  const reader = new SharedValueReader();
  return lines.map((line) => reader.expand(JSON.parse(line)));
};

const effect = {
  type: "invocation",
  callee: "db.orders.insert",
  args: [{ kind: "literal", value: "pending" }],
};

describe("sharedSummaryLines", () => {
  it("writes a repeated value once and refers back to it", () => {
    const summaries = [
      { name: "a", effects: [effect] },
      { name: "b", effects: [effect, { ...effect }] },
    ];
    const lines = written(summaries);

    expect(lines[0]).toContain('"$def":1');
    expect(lines[1]).not.toContain("db.orders.insert");
    expect(lines[1]).toContain('{"$ref":1}');
    expect(readBack(lines)).toEqual(summaries);
  });

  it("writes a value shorter than the threshold where it appears", () => {
    const summaries = [{ at: { line: 1 } }, { at: { line: 1 } }];

    expect(written(summaries)).toEqual(summaries.map((s) => JSON.stringify(s)));
  });

  it("shares a value inside a shared value", () => {
    const repository = { name: "platform", remote: "git@example.com:x.git" };
    const location = { file: "src/orders.ts", repository };
    const summaries = [{ location }, { location }, { other: repository }];
    const lines = written(summaries);

    expect(lines[2]).toMatch(/\{"other":\{"\$ref":\d+\}\}/);
    expect(readBack(lines)).toEqual(summaries);
  });

  it("writes every summary out, even one that repeats another", () => {
    const summary = { kind: "handler", effects: [effect] };
    const lines = written([summary, summary]);

    expect(lines[1]?.startsWith('{"kind":"handler"')).toBe(true);
    expect(readBack(lines)).toEqual([summary, summary]);
  });

  it("reads back a summary with more containers than the log starts with", () => {
    const rows = Array.from({ length: 3000 }, (_, at) => ({
      at: { line: at },
      effect: at % 2 === 0 ? effect : { ...effect, callee: `call${at}` },
    }));
    const summaries = [{ rows }, { rows }];

    expect(readBack(written(summaries))).toEqual(summaries);
  });

  it("prints what JSON.stringify drops or turns into null the same way", () => {
    const shared = {
      long: "a value long enough to be shared",
      gone: undefined,
    };
    const summaries = [
      { values: [shared, undefined] },
      { values: [shared, undefined] },
    ];

    expect(readBack(written(summaries))).toEqual(
      JSON.parse(JSON.stringify(summaries)),
    );
  });
});

describe("SharedValueReader", () => {
  it("gives each reference its own copy", () => {
    const summaries = [{ effects: [effect] }, { effects: [effect] }];
    const [first, second] = readBack(written(summaries)) as {
      effects: { args: unknown[] }[];
    }[];
    first?.effects[0]?.args.push("changed");

    expect(second?.effects[0]?.args).toEqual(effect.args);
  });

  it("leaves a JSON Schema reference alone", () => {
    const schema = { $ref: "#/components/schemas/Order" };

    expect(new SharedValueReader().expand({ schema })).toEqual({ schema });
  });

  it("leaves a reference to nothing written in place for validation to report", () => {
    expect(new SharedValueReader().expand({ effect: { $ref: 4 } })).toEqual({
      effect: { $ref: 4 },
    });
  });
});
