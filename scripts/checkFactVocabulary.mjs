#!/usr/bin/env node
/**
 * checkFactVocabulary.mjs: every relation an adapter adds to the resolution
 * store, and every relation a rule reads that no rule derives, has a line in
 * the fact vocabulary in the resolution package's DESIGN.md. A builder reads
 * that list before adding a fact, so a relation missing from it gets added a
 * second time under another name. A line whose relation nothing emits or
 * reads any more has to come out too.
 *
 * It reads source as text. A rule reads the relation in `lit("x")` and
 * derives the one in `rule("x")`. An adapter emits through `fact(db, "x")`,
 * `add(emitter, "x")` or `db.add("x", row)`. A relation name built at run
 * time is seen only when a rule reads it. The relations a caller asks
 * through are listed in `ASKING_RELATIONS` and need no line.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const VOCABULARY_FILE = "packages/resolution/DESIGN.md";
const VOCABULARY_HEADING = "## The facts an adapter supplies";
const ASKING_FILE = "packages/resolution/src/program.ts";

/** The shared rules, the pack words, and every language adapter. */
const SCOPES = ["packages/resolution/src", "packages/adapter"];

/**
 * Files that run a Datalog program of their own. Their relations never
 * meet the resolution rules, so the vocabulary does not list them.
 */
const OTHER_PROGRAMS = new Map([
  [
    "packages/adapter/typescript/src/resolve/reachableClosure.ts",
    "the reach closure, over entry, calls and reachable",
  ],
  ["packages/adapter/python/src/reach/closure.ts", "the reach closure"],
  ["packages/adapter/ruby/src/reach/closure.ts", "the reach closure"],
  [
    "packages/adapter/typescript/src/resolve/rethrowEnrichment.ts",
    "which rethrows a caller inherits",
  ],
  [
    "packages/adapter/typescript/src/facts/moduleGraph.ts",
    "the module graph behind filesImportingTransitively",
  ],
]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__fixtures__",
  "fixtures",
]);

const RULE_READ = /\b(?:lit|notLit)\(\s*"([A-Za-z]+)"/g;
const RULE_HEAD = /\brule\(\s*"([A-Za-z]+)"/g;
// The relation argument runs up to the first comma, so a ternary choosing
// between two relations gives both.
const EMISSION =
  /(?:\.add|\bfact|\badd)\(\s*(?:[A-Za-z_.]+\s*,\s*)?([^,()]*?)\s*,/g;
const QUOTED_NAME = /"([A-Za-z]+)"/g;
const LISTED_NAME = /^([a-z][A-Za-z]*)\(/;

function sourceFilesUnder(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        sourceFilesUnder(full, found);
      }

      continue;
    }

    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** The relations the vocabulary section lists, one per line in its code blocks. */
export function listedRelations(markdown, heading = VOCABULARY_HEADING) {
  const listed = new Set();
  let inSection = false;
  let inCode = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      inSection = line.trim() === heading;
      continue;
    }

    if (!inSection) {
      continue;
    }

    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }

    const match = inCode ? LISTED_NAME.exec(line) : null;
    if (match !== null) {
      listed.add(match[1]);
    }
  }
  return listed;
}

/** The strings in the `ASKING_RELATIONS` array, or null when it is not found. */
export function askingRelations(source) {
  const array = /ASKING_RELATIONS\b[^=]*=\s*\[([^\]]*)\]/.exec(source);
  if (array === null) {
    return null;
  }

  return new Set([...array[1].matchAll(QUOTED_NAME)].map((m) => m[1]));
}

function noteFirst(found, name, where) {
  if (!found.has(name)) {
    found.set(name, where);
  }
}

/** What one file's rules read and derive, and what it emits, by relation. */
function scanFile(text, relative, seen) {
  for (const match of text.matchAll(RULE_READ)) {
    noteFirst(seen.reads, match[1], `${relative}:${lineAt(text, match.index)}`);
  }

  for (const match of text.matchAll(RULE_HEAD)) {
    seen.heads.add(match[1]);
  }

  for (const match of text.matchAll(EMISSION)) {
    for (const name of match[1].matchAll(QUOTED_NAME)) {
      noteFirst(
        seen.emits,
        name[1],
        `${relative}:${lineAt(text, match.index)}`,
      );
    }
  }
}

/**
 * Every relation missing from the vocabulary, every listed relation nothing
 * uses, and every entry in `otherPrograms` whose file has gone.
 */
export function findVocabularyGaps({
  root,
  vocabularyFile = VOCABULARY_FILE,
  heading = VOCABULARY_HEADING,
  askingFile = ASKING_FILE,
  scopes = SCOPES,
  otherPrograms = OTHER_PROGRAMS,
}) {
  const problems = [];
  const listed = listedRelations(
    fs.readFileSync(path.join(root, vocabularyFile), "utf8"),
    heading,
  );
  if (listed.size === 0) {
    problems.push(
      `${vocabularyFile}: no relations under "${heading}"; update this script`,
    );
  }

  const asking = askingRelations(
    fs.readFileSync(path.join(root, askingFile), "utf8"),
  );
  if (asking === null) {
    problems.push(
      `${askingFile}: no ASKING_RELATIONS array found; update this script`,
    );
  }

  const seen = { reads: new Map(), heads: new Set(), emits: new Map() };
  for (const scope of scopes) {
    const dir = path.join(root, scope);
    if (!fs.existsSync(dir)) {
      problems.push(`${scope}: scope directory is missing; update this script`);
      continue;
    }

    for (const file of sourceFilesUnder(dir, [])) {
      const relative = path.relative(root, file);
      if (!otherPrograms.has(relative)) {
        scanFile(fs.readFileSync(file, "utf8"), relative, seen);
      }
    }
  }

  const needed = new Map();
  for (const [name, where] of seen.reads) {
    if (!seen.heads.has(name)) {
      needed.set(name, `a rule reads it at ${where} and no rule derives it`);
    }
  }

  for (const [name, where] of seen.emits) {
    if (!needed.has(name)) {
      needed.set(name, `emitted at ${where}`);
    }
  }

  const askedThrough = asking ?? new Set();
  for (const [name, why] of needed) {
    if (!askedThrough.has(name) && !listed.has(name)) {
      problems.push(`${name}: ${why}, and the vocabulary has no line for it`);
    }
  }

  for (const name of listed) {
    if (!seen.reads.has(name) && !seen.emits.has(name)) {
      problems.push(
        `${name}: the vocabulary lists it, but nothing emits it and no rule reads it; drop its line`,
      );
    }
  }

  for (const [relative] of otherPrograms) {
    if (!fs.existsSync(path.join(root, relative))) {
      problems.push(
        `${relative}: listed as a program of its own, but the file is gone; drop its entry here`,
      );
    }
  }

  return problems;
}

function main() {
  const problems = findVocabularyGaps({ root: repoRoot });
  if (problems.length > 0) {
    console.error(
      `Every resolution fact has a line in ${VOCABULARY_FILE}, under "${VOCABULARY_HEADING.slice(3)}".`,
    );
    console.error(
      "Check there for a fact that already says it; otherwise add a line for the new one:",
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log("check:fact-vocabulary OK: every resolution fact has a line.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
