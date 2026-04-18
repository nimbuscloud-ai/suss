// normalize-coverage-summary.mjs
//
// Rewrites each passed `coverage-summary.json` into the canonical form
// we track in git: machine-independent (path keys relative to the
// containing package root instead of absolute) and pretty-printed
// (2-space indent) so PR diffs show field-level changes rather than
// whole-file reformatting churn.
//
// Callable two ways:
//   1. lint-staged: paths passed as argv (called per-file on staged
//      coverage-summary.json files, before commit).
//   2. generate-coverage-badges.mjs: imported as a function.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Given an absolute path to a coverage-summary.json (vitest's raw
 * output), derive the package root. vitest writes the file at
 * `<pkgRoot>/coverage/coverage-summary.json`, so stripping the trailing
 * `/coverage/coverage-summary.json` gives the root back.
 */
function packageRootFor(summaryPath) {
  return dirname(dirname(summaryPath));
}

export function normalizeSummaryFile(summaryPath) {
  const absPath = resolve(summaryPath);
  if (!existsSync(absPath)) {
    return false;
  }
  const pkgAbsPath = packageRootFor(absPath);

  const raw = readFileSync(absPath, "utf8");
  const data = JSON.parse(raw);

  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    // Replace absolute paths with relative-to-package-root paths.
    // "total" and any other non-path keys are kept as-is.
    const rel = key.startsWith(pkgAbsPath)
      ? key.slice(pkgAbsPath.length + 1) // strip leading slash
      : key;
    normalized[rel] = value;
  }

  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (serialized === raw) {
    return false; // already normalized
  }
  writeFileSync(absPath, serialized, "utf8");
  return true;
}

// CLI entry: if invoked directly with file args, normalize each one.
if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: normalize-coverage-summary.mjs <path>...");
    process.exit(2);
  }
  for (const p of paths) {
    const changed = normalizeSummaryFile(p);
    if (changed) {
      console.log(`  normalized ${p}`);
    }
  }
}
