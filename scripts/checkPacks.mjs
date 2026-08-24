#!/usr/bin/env node
/**
 * checkPacks.mjs: adding a pack takes four edits, and three of them
 * fail quietly.
 *
 * A pack ships inside `@suss/packs`, so it needs an entry file under
 * `packages/packs/src`, a subpath in that package's exports, a
 * devDependency so turbo builds it first, and `private: true` on its
 * own manifest. Miss the exports entry and `-f <name>` resolves to
 * nothing at run time, on the published package alone. Miss the
 * devDependency and CI typechecks against declarations nothing built.
 * Miss `private` and the release publishes the same code twice.
 *
 * Usage: `node scripts/checkPacks.mjs`
 */

import fs from "node:fs";
import path from "node:path";

import { findManifests, PACKAGES_DIR } from "./workspacePackages.mjs";

const PACKS_DIR = path.join(PACKAGES_DIR, "packs");
const problems = [];

/** The `-f` names, which are what everything else is compared against. */
const builtins = [
  ...fs
    .readFileSync(path.join(PACKAGES_DIR, "cli", "src", "extract.ts"), "utf8")
    .matchAll(/^\s*"?([\w-]+)"?:\s*"(@suss\/packs\/[\w-]+)",$/gm),
].map(([, name, specifier]) => ({ name, specifier }));

if (builtins.length === 0) {
  problems.push(
    "No built-in packs found in extract.ts, so either the list moved or its shape changed and this check is reading nothing.",
  );
}

const packs = JSON.parse(
  fs.readFileSync(path.join(PACKS_DIR, "package.json"), "utf8"),
);
const manifestByName = new Map(
  findManifests().map((file) => [
    JSON.parse(fs.readFileSync(file, "utf8")).name,
    file,
  ]),
);

for (const { name, specifier } of builtins) {
  if (specifier !== `@suss/packs/${name}`) {
    problems.push(
      `-f ${name} points at ${specifier}, and a pack's subpath is its own name.`,
    );
  }

  const entry = path.join(PACKS_DIR, "src", `${name}.ts`);
  if (!fs.existsSync(entry)) {
    problems.push(
      `-f ${name} has no entry file. Add packages/packs/src/${name}.ts re-exporting the factory.`,
    );
    continue;
  }

  if (packs.exports[`./${name}`] === undefined) {
    problems.push(
      `-f ${name} is missing from the exports of @suss/packs, so the subpath resolves inside this workspace and nowhere else.`,
    );
  }

  const reexported = fs
    .readFileSync(entry, "utf8")
    .match(/export \{ default \} from "(@suss\/[\w-]+)"/);
  if (reexported === null) {
    problems.push(
      `packages/packs/src/${name}.ts re-exports no default, and the default is the factory the CLI loads.`,
    );
    continue;
  }

  const bundled = reexported[1];
  if (packs.devDependencies?.[bundled] === undefined) {
    problems.push(
      `${bundled} is bundled into @suss/packs and is not one of its devDependencies, so turbo builds it after the package that needs it.`,
    );
  }

  const manifest = manifestByName.get(bundled);
  if (manifest === undefined) {
    problems.push(`${bundled} is re-exported by @suss/packs and is not here.`);
    continue;
  }

  if (JSON.parse(fs.readFileSync(manifest, "utf8")).private !== true) {
    problems.push(
      `${bundled} ships inside @suss/packs and is not private, so a release publishes the same code under two names.`,
    );
  }
}

const named = new Set(builtins.map((builtin) => builtin.name));
for (const file of fs.readdirSync(path.join(PACKS_DIR, "src"))) {
  const entry = file.replace(/\.ts$/, "");
  if (file.endsWith(".ts") && !named.has(entry)) {
    problems.push(
      `packages/packs/src/${file} has no -f name in BUILTIN_FRAMEWORKS, so nothing reaches it.`,
    );
  }
}

// The README says what suss reads, and that claim is the first thing a
// reader sees. A pack that ships without a mention there is a
// drift-detection tool with drifting docs.
const readme = fs.readFileSync(
  path.join(PACKAGES_DIR, "..", "README.md"),
  "utf8",
);
const unmentioned = builtins
  .map((builtin) => builtin.name)
  .filter((name) => !readme.includes(`\`${name}\``));
if (unmentioned.length > 0) {
  problems.push(
    `README.md never mentions ${unmentioned.join(", ")}, so somebody reading it does not know suss can read that.`,
  );
}

const claimed = /^(\w+) packs read code today/m.exec(readme);
const WRITTEN_NUMBERS = {
  Twenty: 20,
  "Twenty-five": 25,
  Thirty: 30,
  "Thirty-five": 35,
  Forty: 40,
};
if (claimed !== null && WRITTEN_NUMBERS[claimed[1]] !== builtins.length) {
  problems.push(
    `README.md says "${claimed[1]} packs read code today" and there are ${builtins.length}.`,
  );
}

if (problems.length > 0) {
  process.stderr.write(
    `${problems.length} pack wiring problem(s):\n${problems
      .map((line) => `  ${line}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `Every one of the ${builtins.length} packs has an entry, a subpath, a build edge, and stays inside @suss/packs.\n`,
);
