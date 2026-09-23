import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findBrokenLinks } from "./checkDocLinks.mjs";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "checkDocLinks",
);

const problems = findBrokenLinks({ root });

function problemsIn(file) {
  return problems.filter((problem) => problem.startsWith(`${file}: `));
}

test("resolves site-root links, directory index pages and static files", () => {
  assert.deepEqual(problemsIn(path.join("docs", "resolving.md")), []);
});

test("reports an anchor the directory's index page does not contain", () => {
  assert.deepEqual(problemsIn(path.join("design", "notes.md")), [
    "design/notes.md: /reference/cli/#suss-ask points at a heading docs/reference/cli/index.md does not contain",
    "design/notes.md: /reference/cli#reading-the-output points at a heading docs/reference/cli/index.md does not contain",
    "design/notes.md: ../docs/reference/cli/#reading-the-output points at a heading docs/reference/cli/index.md does not contain",
    "design/notes.md: /boundary-semantics points at a file that does not exist",
  ]);
});
