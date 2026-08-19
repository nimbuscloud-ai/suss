#!/usr/bin/env node
/**
 * checkNameSyntax.mjs: the boundary-name brace syntax has one author.
 *
 * A container or an access path means one of three things, told apart
 * by its braces: a literal, a pattern with holes, or a reference.
 * `boundaryName.ts` in @suss/ir-core is the only module that reads or
 * writes those braces; a second parser can disagree about which is
 * which, and a reference once shipped written one way by the adapter
 * and read another by the checker (#456). This scans the packages that
 * produce or pair boundary names for the textual tells of a second
 * author. A file that handles a different brace syntax goes in EXEMPT
 * with a sentence saying why. Usage: `node scripts/checkNameSyntax.mjs`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Where boundary names are produced or paired. */
const SCOPES = [
  "packages/checker/src",
  "packages/framework",
  "packages/contract",
  "packages/adapter/typescript/src/resolve",
  "packages/adapter/python/src",
  "packages/adapter/ruby/src",
];

/** The textual tell of a second parser or printer. */
const PROBES = [
  { text: "[^}]", says: "a regex that scans for a `{...}` hole" },
  { text: "`{${", says: "a template that spells a hole by hand" },
];

/**
 * Files that handle a brace syntax of their own, with the reason each
 * one is out. An entry here is a decision somebody wrote down.
 */
const EXEMPT = new Map([
  [
    "packages/contract/terraform/src/references.ts",
    "parses Terraform's own ${} interpolation, a different syntax",
  ],
  [
    "packages/adapter/python/src/discovery.ts",
    "reads route-path templates, which have their own brace convention",
  ],
]);

function walk(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      walk(full, found);
      continue;
    }

    if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const offenses = [];
for (const scope of SCOPES) {
  const dir = path.join(repoRoot, scope);
  if (!fs.existsSync(dir)) {
    offenses.push(`${scope}: scope directory is missing; update this script`);
    continue;
  }

  for (const file of walk(dir, [])) {
    const relative = path.relative(repoRoot, file);
    if (EXEMPT.has(relative)) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    for (const probe of PROBES) {
      if (source.includes(probe.text)) {
        offenses.push(`${relative}: ${probe.says} (\`${probe.text}\`)`);
      }
    }
  }
}

for (const [relative] of EXEMPT) {
  if (!fs.existsSync(path.join(repoRoot, relative))) {
    offenses.push(`${relative}: exempt file is gone; drop its entry here`);
  }
}

if (offenses.length > 0) {
  console.error(
    "The boundary-name brace syntax has one author, boundaryName.ts in @suss/ir-core.",
  );
  console.error(
    "Call parseBoundaryName / boundaryNameString / patternHole instead, or add an EXEMPT entry with a reason:",
  );
  for (const offense of offenses) {
    console.error(`  - ${offense}`);
  }
  process.exit(1);
}

console.log("check:name-syntax OK: one author for the boundary-name syntax.");
