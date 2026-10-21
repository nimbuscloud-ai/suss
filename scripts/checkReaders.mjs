#!/usr/bin/env node
/**
 * checkReaders.mjs: a value has one reader, and it is not the syntax.
 *
 * What a name was written as, what a template folds to, which function
 * a declaration is, which module an import came from: the evaluator and
 * the resolution store answer all four. An audit found about sixty
 * readers written beside a call site instead, two thirds of them after
 * the facility existed. This scans for the tells of one more.
 *
 * Each package lists its failing files in `readerExempt.json`. The rule
 * is in design/docs-internal/style.md#reading-a-value.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findManifests } from "./workspacePackages.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Where a value gets read: the adapters outside the facility, and every pack. */
const SCOPES = [
  "packages/adapter/typescript/src",
  "packages/adapter/python/src",
  "packages/adapter/ruby/src",
  "packages/framework",
  "packages/contract",
  "packages/runtime",
  "packages/client",
];

/**
 * The facility itself. These modules read syntax because reading it is
 * the job they do for everybody else.
 */
const FACILITY = [
  "packages/adapter/typescript/src/values",
  "packages/adapter/typescript/src/facts",
  "packages/adapter/typescript/src/walk",
  "packages/adapter/typescript/src/moduleExports.ts",
  "packages/adapter/typescript/src/resolve/functionBehind.ts",
  "packages/adapter/typescript/src/discovery/resolveValue.ts",
  "packages/adapter/typescript/src/discovery/importScan.ts",
  "packages/adapter/python/src/values",
  "packages/adapter/python/src/facts",
  "packages/adapter/python/src/ast.ts",
  "packages/adapter/ruby/src/values",
  "packages/adapter/ruby/src/facts",
  "packages/adapter/ruby/src/ast.ts",
];

/** A file under a tree-sitter adapter reads a different syntax from a ts-morph one. */
const TREE_SITTER_SCOPES = [
  "packages/adapter/python/src",
  "packages/adapter/ruby/src",
];

/**
 * The textual tells of a second reader. `reads` is "ts-morph" for a
 * probe that only makes sense against the TypeScript adapter's syntax,
 * "tree-sitter" for one that only makes sense against Python's or
 * Ruby's, and "any" for a spelling that turns up in both.
 */
const PROBES = [
  {
    text: ".getInitializer()",
    reads: "ts-morph",
    says: "chases a declaration's initializer; `writtenNodeOf` gives what a name was written as",
  },
  {
    text: ".getSymbol()",
    reads: "ts-morph",
    says: "walks to a symbol to find out what a name is; `resolveWrittenValue` answers that",
  },
  {
    text: ".getDeclarations()",
    reads: "ts-morph",
    says: "walks to a declaration to find out what a name is; `resolveWrittenValue` answers that",
  },
  {
    text: ".getDefinitionNodes()",
    reads: "ts-morph",
    says: "follows an identifier to its definition; `functionTargetOf` and `resolveDecl` do that",
  },
  {
    text: ".getAliasedSymbol()",
    reads: "ts-morph",
    says: "unwraps an import alias by hand; `importOriginsOf` says which module a name came from",
  },
  {
    text: ".getValueDeclaration()",
    reads: "ts-morph",
    says: "takes the declaration behind a symbol; `resolveDecl` does that and follows re-exports",
  },
  {
    text: ".getElements()",
    reads: "ts-morph",
    says: "reads an array literal off the syntax; `arrayLiteralOf` reads one through a name too",
  },
  {
    text: ".getProperties()",
    reads: "ts-morph",
    says: "reads an object's properties off the syntax; `propertiesOf` also folds a spread",
  },
  {
    text: ".getLiteralValue()",
    reads: "ts-morph",
    says: "takes a literal off the syntax; `stringValueOf` also folds a template and a concatenation",
  },
  {
    text: ".getNamedImports()",
    reads: "ts-morph",
    says: "reads an import clause; `namedImportsOf` and `importedNamesOf` do that",
  },
  {
    text: ".getImportDeclarations()",
    reads: "ts-morph",
    says: "scans a file's imports; `matchingImportDeclarations` and `importedRootsOf` do that",
  },
  {
    text: "findReferencesAsNodes",
    reads: "ts-morph",
    says: "searches the project for references; the resolution store already has those edges",
  },
  {
    text: ".isParenthesizedExpression(",
    reads: "ts-morph",
    says: "peels or climbs a wrapper by hand; `peelSyntax`, `peelValue`, `peelParens` and `climbSyntax` in walk/unwrap.ts do that",
  },
  {
    text: ".isAsExpression(",
    reads: "ts-morph",
    says: "peels or climbs a wrapper by hand; `peelSyntax`, `peelValue` and `climbSyntax` in walk/unwrap.ts do that",
  },
  {
    text: ".text.slice(1, -1)",
    reads: "tree-sitter",
    says: "strips a string node's quotes by index; `stringValueOf` reads the string",
  },
  {
    text: "parseInt(node.text",
    reads: "tree-sitter",
    says: "parses a number off a node's text; `evaluatedValue` gives what the node evaluates to",
  },
  {
    text: "replace(/^[\"']|[\"']$/",
    reads: "any",
    says: "strips the quotes off a node's text; the evaluator hands back the string itself",
  },
  {
    text: "replace(/^:/",
    reads: "any",
    says: "strips a leading symbol colon off a node's text; `symbolValue` in ast.ts does that",
  },
];

/**
 * Files that read syntax today, with the functions that do it, kept in a
 * `readerExempt.json` at the root of the package that owns the file. A
 * key is the file's path inside that package, and the value is the
 * reason. Every entry is either a copy of the facility waiting to be
 * deleted or a read that is not about a value at all, and the reason
 * says which.
 */
const EXEMPT_FILE = "readerExempt.json";

/** The package.json directories under `root`, in a fixed order. */
function packageDirsUnder(root) {
  return findManifests(path.join(root, "packages"))
    .map((manifest) => path.relative(root, path.dirname(manifest)))
    .map((dir) => dir.split(path.sep).join("/"))
    .sort();
}

/** One package's exempt list, with each key made relative to the repo root. */
function exemptionsOf(root, dir) {
  const file = path.join(root, dir, EXEMPT_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }

  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.entries(entries).map(([relative, reason]) => {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `${dir}/${EXEMPT_FILE}: the entry for ${relative} needs a reason`,
      );
    }
    return [`${dir}/${relative}`, reason];
  });
}

/** Every package's exempt list, keyed by path from the repo root. */
export function readExemptions(root) {
  return new Map(
    packageDirsUnder(root).flatMap((dir) => exemptionsOf(root, dir)),
  );
}

function isUnder(relative, entry) {
  return relative === entry || relative.startsWith(`${entry}/`);
}

function sourceFilesUnder(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__fixtures__" ||
        entry.name === "fixtures"
      ) {
        continue;
      }
      sourceFilesUnder(full, found);
      continue;
    }

    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

function probeApplies(probe, relative, treeSitterScopes) {
  if (probe.reads === "any") {
    return true;
  }

  const treeSitter = treeSitterScopes.some((scope) => isUnder(relative, scope));
  return probe.reads === "tree-sitter" ? treeSitter : !treeSitter;
}

function hitsIn(line, probe) {
  return probe.text === undefined
    ? probe.pattern.test(line)
    : line.includes(probe.text);
}

/**
 * Every place a second reader shows through, plus the exempt entries
 * whose file has gone, which are the ones to delete from the list.
 */
export function findSecondReaders({
  root,
  scopes = SCOPES,
  facility = FACILITY,
  probes = PROBES,
  exempt = readExemptions(root),
  treeSitterScopes = TREE_SITTER_SCOPES,
}) {
  const offenses = [];
  const stillReading = new Set();
  for (const scope of scopes) {
    const dir = path.join(root, scope);
    if (!fs.existsSync(dir)) {
      offenses.push(`${scope}: scope directory is missing; update this script`);
      continue;
    }

    for (const file of sourceFilesUnder(dir, [])) {
      const relative = path.relative(root, file);
      if (facility.some((entry) => isUnder(relative, entry))) {
        continue;
      }

      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        for (const probe of probes) {
          if (
            !probeApplies(probe, relative, treeSitterScopes) ||
            !hitsIn(line, probe)
          ) {
            continue;
          }

          if (exempt.has(relative)) {
            stillReading.add(relative);
            continue;
          }

          const label = probe.label ?? probe.text;
          offenses.push(
            `${relative}:${index + 1}: ${probe.says} (\`${label}\`)`,
          );
        }
      }
    }
  }

  for (const [relative] of exempt) {
    if (!fs.existsSync(path.join(root, relative))) {
      offenses.push(
        `${relative}: exempt file is gone; drop its entry from the package's readerExempt.json`,
      );
      continue;
    }

    if (!stillReading.has(relative)) {
      offenses.push(
        `${relative}: exempt file reads no syntax any more; drop its entry from the package's readerExempt.json`,
      );
    }
  }

  return offenses;
}

function main() {
  const offenses = findSecondReaders({ root: repoRoot });
  if (offenses.length > 0) {
    console.error(
      "A value is read through the evaluator or the resolution store, never off the syntax at the position.",
    );
    console.error(
      "See design/docs-internal/style.md#reading-a-value. Call the facility, or add an entry with a reason to the readerExempt.json at the root of the package that owns the file:",
    );
    for (const offense of offenses) {
      console.error(`  - ${offense}`);
    }
    process.exit(1);
  }

  console.log("check:readers OK: one reader for a value.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
