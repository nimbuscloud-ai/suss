#!/usr/bin/env node
/**
 * generatePackTables.mjs: write the pack tables on the packages page
 * from what each pack declares.
 *
 * Usage: `node scripts/generatePackTables.mjs` writes them,
 * `node scripts/generatePackTables.mjs --check` fails when they are out
 * of date. CI runs the check.
 */

import fs from "node:fs";
import path from "node:path";

import { marker, packTables } from "./packTables.mjs";
import { PACKAGES_DIR } from "./workspacePackages.mjs";

const PAGE = path.join(PACKAGES_DIR, "..", "docs", "reference", "packages.md");

const before = fs.readFileSync(PAGE, "utf8");
let after = before;

for (const [kind, table] of Object.entries(packTables())) {
  const { start, end } = marker(kind);
  const between = new RegExp(`${escaped(start)}[\\s\\S]*?${escaped(end)}`, "m");
  if (!between.test(after)) {
    process.stderr.write(
      `docs/reference/packages.md has no ${kind} section to write. Put ${start} and ${end} around the table.\n`,
    );
    process.exit(1);
  }
  after = after.replace(between, `${start}\n\n${table}\n\n${end}`);
}

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (after === before) {
  process.stdout.write("The pack tables match what the packs declare.\n");
  process.exit(0);
}

if (process.argv.includes("--check")) {
  process.stderr.write(
    "docs/reference/packages.md is out of date with what the packs declare. Run `npm run docs:packs`.\n",
  );
  process.exit(1);
}

fs.writeFileSync(PAGE, after);
process.stdout.write("Wrote the pack tables in docs/reference/packages.md.\n");
