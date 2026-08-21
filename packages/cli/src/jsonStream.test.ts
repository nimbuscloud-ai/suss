import { constants as BUFFER } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { jsonPieces, writeJson } from "./jsonStream.js";

const joined = (value: unknown, indent = 0) =>
  [...jsonPieces(value, indent)].join("");

/** Values that between them cover every branch of the JSON grammar. */
const shapes: Array<[string, unknown]> = [
  ["null", null],
  ["a number", 42],
  ["a negative float", -1.5],
  ["a string with escapes", 'he said "hi"\n\t\\'],
  ["a unicode string", "héllo ✅ 🎉 日本語"],
  ["true", true],
  ["an empty array", []],
  ["an empty object", {}],
  ["a flat array", [1, "two", false, null]],
  ["a flat object", { a: 1, b: "two", c: null }],
  ["nested containers", { a: [{ b: [1, [2, { c: {} }]] }], d: [[], {}] }],
  ["an array holding empties", [[], {}, [[]], [{}]]],
  ["an object with an empty-array value", { list: [], map: {} }],
  ["keys needing escapes", { 'a"b': 1, "c\nd": 2 }],
];

describe("jsonPieces", () => {
  for (const [name, value] of shapes) {
    for (const indent of [0, 2, 4]) {
      it(`matches JSON.stringify for ${name} at indent ${indent}`, () => {
        expect(joined(value, indent)).toBe(JSON.stringify(value, null, indent));
      });
    }
  }

  it("drops undefined, function and symbol properties like JSON.stringify", () => {
    const value = {
      keep: 1,
      gone: undefined,
      fn: () => 1,
      sym: Symbol("s"),
    };
    expect(joined(value, 2)).toBe(JSON.stringify(value, null, 2));
  });

  it("turns undefined and functions in arrays into null like JSON.stringify", () => {
    const value = [1, undefined, () => 1, Symbol("s"), 2];
    expect(joined(value, 2)).toBe(JSON.stringify(value, null, 2));
  });

  it("honours toJSON", () => {
    const value = { at: new Date("2020-01-01T00:00:00.000Z") };
    expect(joined(value, 2)).toBe(JSON.stringify(value, null, 2));
  });

  // Rendering more text than one string can contain is the point of
  // this one, so it moves half a gigabyte and takes a few seconds. The
  // default timeout fails it whenever the machine is busy.
  it(
    "splits a document that no single string could hold",
    { timeout: 60_000 },
    () => {
      // Each element is well under V8's cap; enough of them together are
      // over it. Joining the pieces would rebuild the same oversized
      // string, so this asserts on the seams instead: the count and the
      // framing.
      const pad = 1024 * 1024;
      const element = { pad: "x".repeat(pad) };
      const count = Math.ceil(BUFFER.MAX_STRING_LENGTH / pad) + 1;
      const values = Array.from({ length: count }, () => element);
      let first = "";
      let last = "";
      let commas = 0;
      let total = 0;
      for (const piece of jsonPieces(values, 2)) {
        first = first === "" ? piece : first;
        last = piece;
        commas += piece === ",\n  " ? 1 : 0;
        total += piece.length;
      }
      expect(first).toBe("[\n  ");
      expect(last).toBe("\n]");
      expect(commas).toBe(count - 1);
      expect(total).toBeGreaterThan(BUFFER.MAX_STRING_LENGTH);
    },
  );

  // Everything above is small enough to render in one `JSON.stringify`
  // call, which is the path that does not differ. These force the split.
  describe("on values past the size where rendering splits", () => {
    const overTheLimit = 5 * 1024 * 1024;

    const splitting: Array<[string, () => unknown]> = [
      [
        "an array of many large elements",
        () => [
          { pad: "a".repeat(overTheLimit) },
          { pad: "b".repeat(overTheLimit) },
        ],
      ],
      [
        "an object whose properties are large",
        () => ({
          first: "a".repeat(overTheLimit),
          nested: { deep: ["b".repeat(overTheLimit), 1, null] },
          last: true,
        }),
      ],
      ["a single string longer than one piece", () => "x".repeat(overTheLimit)],
      [
        "a long string needing escapes throughout",
        () => 'a"b\\c\n\t'.repeat(overTheLimit / 4),
      ],
      [
        "a long string of multi-byte characters",
        () => "日本語é".repeat(overTheLimit / 4),
      ],
      ["a long string of surrogate pairs", () => "🎉".repeat(overTheLimit / 2)],
      [
        "a string whose slice boundary lands on a surrogate pair",
        () => `${"x".repeat(4 * 1024 * 1024 - 1)}${"🎉".repeat(1024 * 1024)}`,
      ],
      [
        "a large string inside a nested array",
        () => [[{ text: "z".repeat(overTheLimit) }]],
      ],
    ];

    for (const [name, build] of splitting) {
      for (const indent of [0, 2, 4]) {
        it(`matches JSON.stringify for ${name} at indent ${indent}`, () => {
          const value = build();
          expect(joined(value, indent)).toBe(
            JSON.stringify(value, null, indent),
          );
        });
      }
    }

    it("emits a long string in more than one piece", () => {
      const pieces = [...jsonPieces("x".repeat(overTheLimit))];
      expect(pieces.length).toBeGreaterThan(3);
    });
  });
});

describe("writeJson", () => {
  const withTempDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-jsonstream-"));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("writes the same bytes JSON.stringify would, plus a newline", async () => {
    await withTempDir(async (dir) => {
      const value = [{ a: 1 }, { b: [1, 2, 3] }];
      const file = path.join(dir, "out.json");
      await writeJson({ value, indent: 2, file });
      expect(fs.readFileSync(file, "utf-8")).toBe(
        `${JSON.stringify(value, null, 2)}\n`,
      );
    });
  });

  it("creates the directory the output sits in", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "nested", "deeper", "out.json");
      await writeJson({ value: [1], indent: 2, file });
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it("round-trips a document with many elements", async () => {
    await withTempDir(async (dir) => {
      const value = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        note: `element ${i}`,
        tags: ["a", "b"],
      }));
      const file = path.join(dir, "many.json");
      await writeJson({ value, indent: 2, file });
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(value);
    });
  });

  it("writes a document past the split threshold byte for byte", async () => {
    // 16MB, the size saleor-dashboard extracts to, so this is the path a
    // large project takes rather than the one-string path.
    await withTempDir(async (dir) => {
      const value = Array.from({ length: 4000 }, (_, i) => ({
        id: i,
        location: { file: `src/components/Thing${i}.tsx`, line: i },
        note: "x".repeat(4000),
        tags: ["a", "b", null],
      }));
      const file = path.join(dir, "large.json");
      await writeJson({ value, indent: 2, file });
      const written = fs.readFileSync(file, "utf-8");
      // More than one piece is what says the split did the writing
      // rather than a single `JSON.stringify`.
      expect([...jsonPieces(value, 2)].length).toBeGreaterThan(1);
      expect(written.length).toBeGreaterThan(15 * 1024 * 1024);
      expect(written).toBe(`${JSON.stringify(value, null, 2)}\n`);
    });
  });
});
