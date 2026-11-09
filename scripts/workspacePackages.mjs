// workspacePackages.mjs
//
// One walk of packages/, shared by every script that has to reason about
// the set of packages this repo ships. preparePublish.mjs uses it to put
// each manifest into a publishable state; checkCoveragePackages.mjs uses
// it to assert each one is under the coverage gate. A second walker
// would eventually disagree with this one, and the disagreement would
// show up as a package nobody is checking.
//
// tools/ is deliberately outside the walk. Those are workspace-local
// helpers that never reach npm.

import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PACKAGES_DIR = path.join(ROOT, "packages");

/**
 * A directory no check reads source or a manifest from: an install, build
 * output, or any dot-directory such as `.suss`, `.turbo` or `.tsbuild`.
 * Skipping them lets a built, installed or tested tree walk the same as a
 * fresh clone. A test that copies a package into `.suss` and is killed
 * before it cleans up would otherwise show up as a second copy of that
 * package.
 */
export function isOutsideSource(name) {
  return name === "node_modules" || name === "dist" || name.startsWith(".");
}

/**
 * Every package.json under packages/. The depth cap covers the two
 * layouts in use, `packages/<name>` and `packages/<group>/<name>`, with
 * room to spare.
 */
export function findManifests(dir = PACKAGES_DIR, depth = 0) {
  if (depth > 3) {
    return [];
  }

  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isOutsideSource(entry.name)) {
      continue;
    }

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findManifests(full, depth + 1));
    } else if (entry.name === "package.json") {
      found.push(full);
    }
  }
  return found;
}

/**
 * The same packages, read and described: directory relative to the repo
 * root (the form coverage-packages.mjs uses), package name, whether the
 * manifest asks to be held back from npm, and whether it declares a
 * coverage run.
 */
export function readWorkspacePackages() {
  return findManifests().map((manifest) => {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    return {
      manifest,
      dir: path
        .relative(ROOT, path.dirname(manifest))
        .split(path.sep)
        .join("/"),
      name: pkg.name,
      isPrivate: pkg.private === true,
      hasCoverageScript: typeof pkg.scripts?.["test:coverage"] === "string",
    };
  });
}
