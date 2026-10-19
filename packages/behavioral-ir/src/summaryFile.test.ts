import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonFileError } from "./documentFile.js";
import { type BehavioralSummary, parseSummaries } from "./index.js";
import { readSummaryFile, writeSummaryFile } from "./summaryFile.js";

function summary(name: string, extra: Partial<BehavioralSummary> = {}) {
  return {
    schemaVersion: 6,
    kind: "handler",
    location: {
      file: "src/routes.ts",
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: {
      id: `src/routes.ts::${name}`,
      name,
      exportPath: [name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:200`,
        conditions: [],
        output: { type: "return", value: { type: "text", value: "ok\n日本" } },
        effects: [],
        location: { start: 2, end: 4 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...extra,
  } as BehavioralSummary;
}

const fixtures = [
  summary("listUsers"),
  summary("getUser", { metadata: { note: "a b" } }),
  summary("deleteUser"),
];

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function target(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-summaries-"));
  dirs.push(dir);
  return path.join(dir, "summaries.json");
}

function errorOf(read: () => unknown): JsonFileError {
  try {
    read();
  } catch (error) {
    if (error instanceof JsonFileError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the read to fail");
}

describe("readSummaryFile", () => {
  it("reads back what writeSummaryFile wrote", () => {
    const file = target();
    writeSummaryFile(file, fixtures);
    expect(readSummaryFile(file)).toEqual(parseSummaries(fixtures));
  });

  it("writes one summary per line with no indentation", () => {
    const file = target();
    writeSummaryFile(file, fixtures);
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    expect(lines).toHaveLength(fixtures.length + 3);
    expect(lines[0]).toBe("[");
    expect(lines.some((line) => line.startsWith(" "))).toBe(false);
  });

  it("reads the indented layout earlier releases wrote", () => {
    const file = target();
    fs.writeFileSync(file, JSON.stringify(fixtures, null, 2));
    expect(readSummaryFile(file)).toEqual(parseSummaries(fixtures));
  });

  it("settles the ids it backfills across the file, as parseSummaries does", () => {
    const legacy = [summary("handler"), summary("handler")].map((s) => {
      const { schemaVersion: _version, ...rest } = s;
      return {
        ...rest,
        identity: { ...rest.identity, id: undefined },
        location: { ...rest.location, range: { start: 1, end: 2 } },
      };
    });
    legacy[1].location.range = { start: 5, end: 8 };
    const file = target();
    writeSummaryFile(file, legacy as unknown as BehavioralSummary[]);
    expect(readSummaryFile(file)).toEqual(
      parseSummaries(JSON.parse(JSON.stringify(legacy))),
    );
  });

  it("names the element and field that did not fit", () => {
    const file = target();
    const broken = [fixtures[0], { ...fixtures[1], kind: 7 }];
    writeSummaryFile(file, broken as BehavioralSummary[]);
    const error = errorOf(() => readSummaryFile(file));
    expect(error.problem).toBe("notSummaries");
    expect(error.issues[0]?.path).toEqual([1, "kind"]);
    expect(error.message).toContain("1.kind");
  });

  it("says a file that is not an array is not summaries", () => {
    const file = target();
    fs.writeFileSync(file, JSON.stringify({ hello: 1 }));
    const error = errorOf(() => readSummaryFile(file));
    expect(error.problem).toBe("notSummaries");
    expect(error.message).toContain("expected array, received object");
  });

  it("reads an empty file of summaries", () => {
    const file = target();
    writeSummaryFile(file, []);
    expect(fs.readFileSync(file, "utf-8")).toBe("[]\n");
    expect(readSummaryFile(file)).toEqual([]);
  });
});
