/**
 * packInventory.mjs: what this repo ships as packs, read from the code
 * that decides it.
 *
 * The `-f` names come from BUILTIN_FRAMEWORKS in the CLI and the
 * `--from` names from CONTRACT_LOADERS beside it, so a check reads the
 * same list a run does. checkPacks.mjs asserts each name is bundled;
 * this module is what everything else counts.
 */

import fs from "node:fs";
import path from "node:path";

import { findManifests, PACKAGES_DIR } from "./workspacePackages.mjs";

/** Every name `-f` takes, in the order the CLI writes them. */
export function packNames() {
  const source = fs.readFileSync(
    path.join(PACKAGES_DIR, "cli", "src", "extract.ts"),
    "utf8",
  );
  return [
    ...source.matchAll(/^\s*"?([\w-]+)"?:\s*"@suss\/packs\/[\w-]+",$/gm),
  ].map(([, name]) => name);
}

/** Every name `--from` takes. */
export function contractSources() {
  const source = fs.readFileSync(
    path.join(PACKAGES_DIR, "cli", "src", "contract.ts"),
    "utf8",
  );
  const table = source.slice(source.indexOf("const CONTRACT_LOADERS"));
  const body = table.slice(0, table.indexOf("\n};"));
  return [...body.matchAll(/^ {2}"?([\w-]+)"?:\s*async/gm)].map(
    ([, name]) => name,
  );
}

/** Every package a release puts on the registry. */
export function publishedPackages() {
  return findManifests()
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
}

/** The pack directories in one group of the workspace. */
export function packDirectories(group) {
  const dir = path.join(PACKAGES_DIR, group);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}
