/**
 * dogfoodBaseline.mjs: how the dogfood counts are stored.
 *
 * Each package keeps its own counts in a dogfood-baseline.json at its
 * root, so a change to one package moves that package's file and no
 * other. scripts/dogfood-baseline.json keeps the two counts no package
 * owns, the cross-package pairs and the finding errors. The totals are
 * the sums of the package files, so they are not stored.
 *
 * Readers get the counts back in the shape the single file used to
 * have: `{ totals, packages }`, with the packages keyed by directory and
 * in name order.
 */

import fs from "node:fs";
import path from "node:path";

import { listFilesAtRef, readJsonFromRef } from "./baselineCompare.mjs";
import { BASELINE_REL_PATH, PACKAGE_BASELINE_FILE } from "./dogfoodOutputs.mjs";
import { findManifests, ROOT } from "./workspacePackages.mjs";

/**
 * Put the package files and the shared counts together. `packages` maps
 * a package directory to its counts, and `shared` has `pairs` and
 * `findingErrors`.
 */
export function assembleBaseline({ packages, shared }) {
  const ordered = Object.entries(packages).sort(([, a], [, b]) =>
    a.name.localeCompare(b.name),
  );
  const counts = ordered.map(([, one]) => one);
  const sum = (field) => counts.reduce((total, one) => total + one[field], 0);
  const carried = (field) =>
    shared[field] === undefined ? {} : { [field]: shared[field] };

  return {
    totals: {
      packages: counts.length,
      packagesWithExports: counts.filter((one) => one.exports > 0).length,
      exports: sum("exports"),
      internal: sum("internal"),
      consumers: sum("consumers"),
      ...carried("pairs"),
      unfollowedCalls: sum("unfollowedCalls"),
      ...carried("findingErrors"),
    },
    packages: Object.fromEntries(ordered),
  };
}

/** Write each package's counts to its own file, and the shared counts to theirs. */
export function writeBaseline({ root = ROOT, packages, shared }) {
  for (const [dir, counts] of Object.entries(packages)) {
    const file = path.join(root, dir, PACKAGE_BASELINE_FILE);
    fs.writeFileSync(file, `${JSON.stringify(counts, null, 2)}\n`);
  }
  fs.writeFileSync(
    path.join(root, BASELINE_REL_PATH),
    `${JSON.stringify(shared, null, 2)}\n`,
  );
}

/** The baseline in the working tree, as a dogfood run left it. */
export function readBaselineFromTree(root = ROOT) {
  const packages = {};
  for (const manifest of findManifests(path.join(root, "packages"))) {
    const file = path.join(path.dirname(manifest), PACKAGE_BASELINE_FILE);
    if (fs.existsSync(file)) {
      const dir = path.relative(root, path.dirname(file));
      packages[dir.split(path.sep).join("/")] = JSON.parse(
        fs.readFileSync(file, "utf8"),
      );
    }
  }
  const shared = JSON.parse(
    fs.readFileSync(path.join(root, BASELINE_REL_PATH), "utf8"),
  );
  return assembleBaseline({ packages, shared });
}

/**
 * The baseline a git ref committed, or `{ found: false }` when the ref
 * has none. A ref from before the counts were split into package files
 * has them all in the one file, and that file is returned as it is.
 */
export function readBaselineFromRef(ref) {
  const shared = readJsonFromRef(ref, BASELINE_REL_PATH);
  if (!shared.found) {
    return { found: false };
  }
  if (shared.value.packages !== undefined) {
    return shared;
  }

  const packages = {};
  for (const file of listFilesAtRef(ref, "packages")) {
    if (path.posix.basename(file) === PACKAGE_BASELINE_FILE) {
      packages[path.posix.dirname(file)] = readJsonFromRef(ref, file).value;
    }
  }
  return {
    found: true,
    value: assembleBaseline({ packages, shared: shared.value }),
  };
}
