import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  documentPieces,
  JsonFileError,
  openJsonFile,
  readJsonFile,
  writeDocumentFile,
} from "./documentFile.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "suss-document-"));

const joined = (value: unknown) => [...documentPieces(value)].join("");

const throughStringify = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as unknown;

/** Values that between them reach every branch of the layout. */
const shapes: Array<[string, unknown]> = [
  ["null", null],
  ["a number", 42],
  ["a string with a newline", "one\ntwo"],
  ["an empty array", []],
  ["an empty object", {}],
  ["an array of scalars", [1, "two", false, null]],
  [
    "an array of objects with awkward strings",
    [
      { text: 'he said "hi"\n\t\\' },
      { text: "héllo ✅ 🎉 日本語" },
      { text: "line separator" },
    ],
  ],
  ["an array with holes JSON.stringify fills", [1, undefined, () => 1, 2]],
  [
    "an object with array and scalar properties",
    {
      schemaVersion: "9",
      configStamp: null,
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      empty: [],
      nested: { list: [1, 2] },
      gone: undefined,
    },
  ],
  ["keys needing escapes", { 'a"b': [1], "c\nd": 2, "e\\": [3, 4] }],
  ["a __proto__ key", JSON.parse('{"__proto__":[1,2],"x":1}') as unknown],
  ["a value with toJSON", { at: new Date("2020-01-01T00:00:00.000Z") }],
];

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
  vi.restoreAllMocks();
});

function fileWith(text: string): string {
  const dir = scratch();
  dirs.push(dir);
  const file = path.join(dir, "doc.json");
  fs.writeFileSync(file, text);
  return file;
}

describe("documentPieces", () => {
  for (const [name, value] of shapes) {
    it(`gives JSON any parser reads for ${name}`, () => {
      expect(JSON.parse(joined(value))).toEqual(throughStringify(value));
    });
  }

  it("puts one array element on each line with no indentation", () => {
    const text = joined([{ a: 1 }, { b: [2, 3] }, "c"]);
    expect(text).toBe('[\n{"a":1},\n{"b":[2,3]},\n"c"\n]\n');
  });

  it("puts each property on its own line and an array's elements under it", () => {
    const text = joined({ version: "9", files: [{ p: 1 }, { p: 2 }], n: 3 });
    expect(text).toBe(
      '{\n"version":"9",\n"files":[\n{"p":1},\n{"p":2}\n],\n"n":3\n}\n',
    );
  });
});

describe("writeDocumentFile and readJsonFile", () => {
  for (const [name, value] of shapes) {
    it(`round-trips ${name}`, () => {
      const file = fileWith("");
      writeDocumentFile(file, value);
      expect(readJsonFile(file)).toEqual(throughStringify(value));
    });
  }

  it("reads a file indented by JSON.stringify", () => {
    const value = shapes[8][1];
    const file = fileWith(JSON.stringify(value, null, 2));
    expect(readJsonFile(file)).toEqual(throughStringify(value));
  });

  it("reads a file written on one line", () => {
    const value = [{ a: 1 }, { b: 2 }];
    const file = fileWith(JSON.stringify(value));
    expect(readJsonFile(file)).toEqual(value);
  });

  it("yields a line-layout array one element at a time", () => {
    const file = fileWith("");
    writeDocumentFile(file, [{ a: 1 }, { a: 2 }, { a: 3 }]);
    const opens = vi.spyOn(fs, "openSync");
    const closes = vi.spyOn(fs, "closeSync");
    const document = openJsonFile(file);
    expect(document.kind).toBe("array");
    const seen: unknown[] = [];
    for (const element of document.kind === "array" ? document.elements : []) {
      seen.push(element);
      break;
    }
    expect(seen).toEqual([{ a: 1 }]);
    // One open for the whole read, closed by the loop stopping early.
    expect(opens).toHaveBeenCalledTimes(1);
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("reads lines longer than one read, and a character split between two reads", () => {
    // A read takes 4 MiB. The first line is `[` and its newline, the
    // second opens with a quote, so the three bytes of 日 start one byte
    // before the end of the first read.
    const first = `${"a".repeat(4 * 1024 * 1024 - 4)}日`;
    const second = { text: "b".repeat(5 * 1024 * 1024), more: "末" };
    const file = fileWith("");
    writeDocumentFile(file, [first, second, "last"]);
    expect(readJsonFile(file)).toEqual([first, second, "last"]);
  });

  it("replaces the target only once the write finishes", () => {
    const file = fileWith("");
    writeDocumentFile(file, [{ before: true }]);
    const broken = {
      toJSON: () => {
        throw new Error("interrupted");
      },
    };

    expect(() => writeDocumentFile(file, [{ a: 1 }, broken])).toThrow(
      "interrupted",
    );
    expect(readJsonFile(file)).toEqual([{ before: true }]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["doc.json"]);
  });

  it("creates the directory it writes into", () => {
    const dir = scratch();
    dirs.push(dir);
    const file = path.join(dir, "deeper", "out.json");
    writeDocumentFile(file, [1]);
    expect(readJsonFile(file)).toEqual([1]);
  });
});

describe("reading a file that is not whole", () => {
  function problemOf(file: string): JsonFileError {
    try {
      readJsonFile(file);
    } catch (error) {
      if (error instanceof JsonFileError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected the read to fail");
  }

  it("says an array cut at a line boundary ends before its bracket", () => {
    const error = problemOf(fileWith('[\n{"a":1},\n{"a":2},\n'));
    expect(error.problem).toBe("notJson");
    expect(error.message).toContain("ends before its closing bracket");
  });

  it("names the line an array was cut in", () => {
    const error = problemOf(fileWith('[\n{"a":1},\n{"a":'));
    expect(error.problem).toBe("notJson");
    expect(error.detail).toMatch(/^line 3: /);
  });

  it("says an object cut short ends before its brace", () => {
    const error = problemOf(fileWith('{\n"a":1,\n"b":[\n1,\n2\n],\n'));
    expect(error.message).toContain("ends before its closing brace");
  });

  it("refuses text after the document", () => {
    const error = problemOf(fileWith("[\n1\n]\nmore\n"));
    expect(error.detail).toBe("line 4: Unexpected text after the document");
  });

  it("says an indented file is too large to read before reading it", () => {
    const file = fileWith(JSON.stringify([1], null, 2));
    const real = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(
      (fd: number) =>
        ({ ...real(fd), size: 0x20000000 }) as unknown as fs.Stats,
    );
    const error = problemOf(file);
    expect(error.problem).toBe("tooLarge");
    expect(error.message).toContain("Run the extract again");
  });

  it("says an object line that does not open with a property name is not JSON", () => {
    const error = problemOf(fileWith('{\n"a":1,\n2\n}\n'));
    expect(error.detail).toBe("line 3: Expected a property name");
  });

  it("says a property name without a colon after it is not JSON", () => {
    const error = problemOf(fileWith('{\n"a\\"b"1\n}\n'));
    expect(error.detail).toBe(
      "line 2: Expected a colon after the property name",
    );
  });

  it("reads a file too short to be in the line layout", () => {
    expect(readJsonFile(fileWith("7"))).toBe(7);
  });

  it("says a directory cannot be read", () => {
    const dir = scratch();
    dirs.push(dir);
    expect(problemOf(dir).problem).toBe("unreadable");
  });

  it("says a missing file cannot be read", () => {
    const error = problemOf(path.join(os.tmpdir(), "suss-no-such-file.json"));
    expect(error.problem).toBe("unreadable");
  });

  it("says a file that is not JSON is not JSON", () => {
    const error = problemOf(fileWith("not json"));
    expect(error.problem).toBe("notJson");
  });
});
