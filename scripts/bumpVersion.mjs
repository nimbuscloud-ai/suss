#!/usr/bin/env node
// bumpVersion.mjs - set the one version every package releases at.
//
//   npm run bump patch
//   npm run bump 0.1.0
//
// A person runs this, reads the diff, and commits it. The release
// workflow publishes whatever version is committed, so it never has to
// decide what the next one is, and the version that goes to the
// registry is one somebody approved in a pull request.
//
// The number lives in the root package.json. preparePublish copies it
// to all of the packages and repoints their dependencies on each other,
// so this writes one field and lets that script do the rest.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_MANIFEST = path.join(ROOT, "package.json");

const request = process.argv[2];

if (request === undefined) {
  fail(
    "Say what to bump to: patch, minor, major, or an exact version.\n" +
      "  npm run bump patch",
  );
}

const current = readJson(ROOT_MANIFEST).version;
const next = resolveVersion(current, request);

if (next === current) {
  fail(`The root package.json already says ${current}.`);
}

writeVersion(next);

try {
  execFileSync("node", [path.join(ROOT, "scripts", "preparePublish.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  // preparePublish has already said what went wrong. The root manifest
  // is at the new version and the packages are not, so whoever runs
  // this needs to know the tree is half written.
  fail(
    `preparePublish stopped, so the root package.json says ${next} and the` +
      " packages still do not. Fix what it reported, then run this again.",
  );
}

// The lockfile records a version for every workspace package, so it
// goes stale the moment those change, and `npm ci` refuses to run
// against a lockfile that disagrees with the manifests. That is the
// first thing the release workflow does, so the bump commit has to
// carry the new lockfile with it.
try {
  execFileSync("npm", ["install", "--package-lock-only"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  fail(
    "npm could not rewrite package-lock.json. The manifests are at" +
      ` ${next} and the lockfile is not, so \`npm ci\` would fail. Run` +
      " `npm install --package-lock-only` yourself once npm is happy.",
  );
}

console.log(
  `\n${current} -> ${next}\n\n` +
    "Next:\n" +
    "  git diff                      read what changed\n" +
    `  git commit -am "chore: release ${next}"\n` +
    "  open a pull request, and once it is on main run\n" +
    "  Actions -> Release -> Run workflow\n",
);

// ---------------------------------------------------------------------

function resolveVersion(from, requested) {
  const steps = {
    major: ([major]) => [major + 1, 0, 0],
    minor: ([major, minor]) => [major, minor + 1, 0],
    patch: ([major, minor, patch]) => [major, minor, patch + 1],
  };

  const step = steps[requested];
  if (step === undefined) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(requested)) {
      fail(
        `"${requested}" is not patch, minor, major, or a version like 1.2.3.`,
      );
    }
    return requested;
  }

  const parts = from.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    fail(
      `The root version is "${from}", which this cannot bump. Pass an exact version.`,
    );
  }
  return step(parts).join(".");
}

function writeVersion(version) {
  const manifest = readJson(ROOT_MANIFEST);
  manifest.version = version;
  fs.writeFileSync(ROOT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}
