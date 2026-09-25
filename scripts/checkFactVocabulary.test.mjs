import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  askingRelations,
  findVocabularyGaps,
  listedRelations,
} from "./checkFactVocabulary.mjs";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "checkFactVocabulary",
);

const REACH = "packages/adapter/example/src/reach.ts";

function gapsFor({
  vocabularyFile = "packages/resolution/DESIGN.md",
  otherPrograms = new Map([[REACH, "the reach closure"]]),
} = {}) {
  return findVocabularyGaps({
    root,
    vocabularyFile,
    scopes: ["packages/resolution/src", "packages/adapter"],
    otherPrograms,
  });
}

test("says nothing when every relation has a line", () => {
  assert.deepEqual(gapsFor(), []);
});

test("reports a relation a rule reads and none derives, with where it is read", () => {
  const gaps = gapsFor({ vocabularyFile: "packages/resolution/INCOMPLETE.md" });
  assert.ok(
    gaps.some((gap) =>
      /^func: a rule reads it at packages\/resolution\/src\/rules\.ts:\d+ and no rule derives it/.test(
        gap,
      ),
    ),
    gaps.join("\n"),
  );
});

test("reports a relation an adapter emits, either side of a ternary", () => {
  const gaps = gapsFor({ vocabularyFile: "packages/resolution/INCOMPLETE.md" });
  for (const name of ["callArg", "reportImport"]) {
    assert.ok(
      gaps.some((gap) =>
        gap.startsWith(
          `${name}: emitted at packages/adapter/example/src/facts.ts:`,
        ),
      ),
      gaps.join("\n"),
    );
  }
});

test("leaves out derived relations and the ones a caller asks through", () => {
  const gaps = gapsFor({ vocabularyFile: "packages/resolution/INCOMPLETE.md" });
  const reported = gaps.map((gap) => gap.split(":")[0]);
  assert.deepEqual(reported.sort(), [
    "callArg",
    "func",
    "reportImport",
    "retiredFact",
  ]);
});

test("reports a listed relation that nothing emits or reads", () => {
  const gaps = gapsFor({ vocabularyFile: "packages/resolution/INCOMPLETE.md" });
  assert.ok(
    gaps.includes(
      "retiredFact: the vocabulary lists it, but nothing emits it and no rule reads it; drop its line",
    ),
    gaps.join("\n"),
  );
});

test("a program of its own is left out, and reported once it is not", () => {
  const gaps = gapsFor({ otherPrograms: new Map() });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /^entry: a rule reads it at .*reach\.ts:\d+/);
});

test("an entry for a program whose file is gone has to come out", () => {
  const gone = "packages/adapter/example/src/gone.ts";
  const gaps = gapsFor({
    otherPrograms: new Map([
      [REACH, "the reach closure"],
      [gone, "gone"],
    ]),
  });
  assert.deepEqual(gaps, [
    `${gone}: listed as a program of its own, but the file is gone; drop its entry here`,
  ]);
});

test("reads only the code blocks under the vocabulary heading", () => {
  const markdown = [
    "## The facts an adapter supplies",
    "call(r, c) outside a code block",
    "```",
    "func(f)                     f is a function",
    "```",
    "## What comes out",
    "```",
    "invokes(r, f)               the call r runs f",
    "```",
  ].join("\n");
  assert.deepEqual([...listedRelations(markdown)], ["func"]);
});

test("finds the asking relations, or says it could not", () => {
  assert.deepEqual(
    [...askingRelations('const ASKING_RELATIONS = ["wanted", "wantedType"];')],
    ["wanted", "wantedType"],
  );
  assert.equal(askingRelations("const OTHER = [];"), null);
});
