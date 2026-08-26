#!/usr/bin/env node
// checkFindingsCatalog.mjs: every finding kind suss can emit has an
// entry in the catalog, and every entry is a kind that exists.
//
// A field tester read the catalog, found the behavioural kinds covered
// and all eight intent kinds missing, and had to guess at what those
// meant. Nothing had noticed, because the catalog is prose and the
// kinds are enums in two different packages. This reads both.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG = path.join(ROOT, "docs/reference/findings.md");

/** The kinds a zod `z.enum([...])` literal declares. */
function enumMembers(source, schemaName) {
  const start = source.indexOf(`${schemaName} = z.enum([`);
  if (start < 0) {
    throw new Error(`${schemaName} is not a z.enum literal any more.`);
  }
  const body = source
    .slice(start, source.indexOf("]);", start))
    // A doc comment can quote a value ("read" in the aspect note), and
    // that is not a member of this enum.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

const declared = [
  ...enumMembers(
    fs.readFileSync(
      path.join(ROOT, "packages/behavioral-ir/src/schemas.ts"),
      "utf8",
    ),
    "export const FindingKindSchema",
  ),
  ...enumMembers(
    fs.readFileSync(
      path.join(ROOT, "packages/behavioral-ir/src/schemas.ts"),
      "utf8",
    ),
    "export const RunFindingKindSchema",
  ),
  ...enumMembers(
    fs.readFileSync(
      path.join(ROOT, "packages/intent-ir/src/findings.ts"),
      "utf8",
    ),
    "export const IntentFindingKindSchema",
  ),
];

const catalog = fs.readFileSync(CATALOG, "utf8");
// A shipped kind gets its own heading. A reserved one, with no emitter
// to describe, is a bullet in the reserved list.
const documented = new Set([
  ...[...catalog.matchAll(/^### `([a-zA-Z]+)`/gm)].map((m) => m[1]),
  ...[...catalog.matchAll(/^- `([a-zA-Z]+)`: (?:error|warning|info)\./gm)].map(
    (m) => m[1],
  ),
]);

const missing = declared.filter((kind) => !documented.has(kind));
const unknown = [...documented].filter((kind) => !declared.includes(kind));

if (missing.length > 0 || unknown.length > 0) {
  for (const kind of missing) {
    console.error(
      `${kind} can be emitted and the catalog has no entry for it.`,
    );
  }
  for (const kind of unknown) {
    console.error(`The catalog documents ${kind}, which no schema declares.`);
  }
  console.error(
    "\nEvery kind needs a heading in docs/reference/findings.md, or a bullet in the reserved list.",
  );
  process.exit(1);
}

console.log(
  `Every one of the ${declared.length} finding kinds has a catalog entry.`,
);
