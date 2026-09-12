import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findSecondReaders } from "./checkReaders.mjs";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "checkReaders",
);

const SCOPES = ["packages/framework", "packages/adapter/python/src"];
const TREE_SITTER_SCOPES = ["packages/adapter/python/src"];

function offensesFor(fixture, exempt = new Map()) {
  return findSecondReaders({
    root: path.join(fixtures, fixture),
    scopes: SCOPES,
    facility: [],
    exempt,
    treeSitterScopes: TREE_SITTER_SCOPES,
  });
}

test("says nothing about code that asks the facility", () => {
  assert.deepEqual(offensesFor("passing"), []);
});

test("reports the file, the line and the probe that fired", () => {
  const offenses = offensesFor("offending");
  assert.equal(offenses.length, 2);
  assert.ok(
    offenses.some((offense) =>
      offense.startsWith(
        "packages/framework/example/src/index.ts:5: takes a literal off the syntax",
      ),
    ),
    offenses.join("\n"),
  );
  assert.ok(
    offenses.some((offense) =>
      offense.startsWith(
        "packages/adapter/python/src/routes.ts:3: strips a string node's quotes",
      ),
    ),
    offenses.join("\n"),
  );
});

test("a probe fires only against the syntax it is about", () => {
  const onlyPython = findSecondReaders({
    root: path.join(fixtures, "offending"),
    scopes: ["packages/adapter/python/src"],
    facility: [],
    exempt: new Map(),
    treeSitterScopes: TREE_SITTER_SCOPES,
  });
  assert.equal(onlyPython.length, 1);
  assert.match(onlyPython[0], /routes\.ts:3/);
});

test("an exempt file passes", () => {
  const exempt = new Map([
    ["packages/framework/example/src/index.ts", "routePathOf"],
    ["packages/adapter/python/src/routes.ts", "routePathOf"],
  ]);
  assert.deepEqual(offensesFor("offending", exempt), []);
});

test("an exempt entry that no longer reads syntax has to come out", () => {
  const exempt = new Map([
    ["packages/framework/example/src/index.ts", "routePathOf"],
  ]);
  const offenses = offensesFor("passing", exempt);
  assert.deepEqual(offenses, [
    "packages/framework/example/src/index.ts: exempt file reads no syntax any more; drop its entry here",
  ]);
});

test("an exempt entry for a file that is gone has to come out", () => {
  const exempt = new Map([["packages/framework/gone/src/index.ts", "gone"]]);
  const offenses = offensesFor("passing", exempt);
  assert.deepEqual(offenses, [
    "packages/framework/gone/src/index.ts: exempt file is gone; drop its entry here",
  ]);
});
