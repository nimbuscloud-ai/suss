#!/usr/bin/env node
// preparePublish.mjs: put every workspace package into a publishable
// state, and keep them there.
//
// Four things have to be true before `npm publish` does the right thing:
//
//   1. No package carries `private: true`, which npm refuses to publish.
//   2. Every package declares `publishConfig.access: "public"`, because a
//      scoped package defaults to restricted and the publish fails
//      without a paid org.
//   3. Cross-package dependencies name an exact version rather than "*".
//      "*" resolves locally under npm workspaces, so it looks fine here,
//      but a published package carrying it would install whatever the
//      latest release happens to be, including one built against a
//      different IR.
//   4. Cross-package peer dependencies carry a caret on that version.
//      A peer is resolved by whoever installs the package rather than by
//      the package, and since npm 7 it is installed rather than merely
//      warned about, so the range is a claim about what this release
//      works against and npm will act on it. "^" is that claim: it is
//      how the third-party peers here are already written, and it widens
//      on its own as the version grows. Below 0.1.0 it widens to
//      nothing: ^0.0.2 is >=0.0.2 <0.0.3, one version, which is the
//      right reading of a set that has promised no stability yet.
//
// Run with --check to assert all four without writing, which is what
// CI does. Run without arguments to fix them.

import fs from "node:fs";
import path from "node:path";

import { findManifests, PACKAGES_DIR, ROOT } from "./workspacePackages.mjs";

/** The version every package publishes at. One number for the whole set. */
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

/** Rewrite one manifest. Returns the list of what it changed. */
function prepare(manifest, { write }) {
  const raw = fs.readFileSync(manifest, "utf8");
  const pkg = JSON.parse(raw);
  const changes = [];

  if (pkg.private === true) {
    changes.push("private: true");
    if (write) {
      delete pkg.private;
    }
  }

  if (pkg.version !== VERSION) {
    changes.push(`version ${pkg.version} -> ${VERSION}`);
    if (write) {
      pkg.version = VERSION;
    }
  }

  if (pkg.publishConfig?.access !== "public") {
    changes.push("missing publishConfig.access");
    if (write) {
      pkg.publishConfig = { ...pkg.publishConfig, access: "public" };
    }
  }

  // A dependency is resolved for the consumer, so it gives the one
  // version this release was built against. A peer is resolved by the
  // consumer, so it gives the range this release works against. A dev
  // dependency reaches no consumer at all, and npm fetches a sibling from
  // the registry rather than linking it whenever the version disagrees,
  // so an exact one breaks the workspace the moment a bump lands. `*`
  // links whatever the workspace has and never goes stale.
  for (const [field, want] of [
    ["dependencies", VERSION],
    ["devDependencies", "*"],
    ["peerDependencies", `^${VERSION}`],
  ]) {
    const deps = pkg[field];
    if (deps === undefined) {
      continue;
    }
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@suss/") || range === want) {
        continue;
      }
      changes.push(`${field}.${name} ${range} -> ${want}`);
      if (write) {
        deps[name] = want;
      }
    }
  }

  if (write && changes.length > 0) {
    fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return changes;
}

const check = process.argv.includes("--check");
const manifests = findManifests(PACKAGES_DIR);
let problems = 0;

// npm only ships a LICENSE that is in the package directory, so every
// package keeps a copy of the root one. They are committed rather than
// written at publish time, so a fresh clone is already publishable and
// --check has something to assert against in CI.
const LICENSE = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");

for (const manifest of manifests) {
  const licenseFile = path.join(path.dirname(manifest), "LICENSE");
  const licensed =
    fs.existsSync(licenseFile) &&
    fs.readFileSync(licenseFile, "utf8") === LICENSE;
  if (!licensed) {
    if (check) {
      problems += 1;
      process.stdout.write(
        `  ${path.relative(ROOT, licenseFile)}: missing or out of date\n`,
      );
    } else {
      fs.writeFileSync(licenseFile, LICENSE);
    }
  }

  const changes = prepare(manifest, { write: !check });
  if (changes.length === 0) {
    continue;
  }
  problems += changes.length;
  const rel = path.relative(ROOT, manifest);
  for (const change of changes) {
    process.stdout.write(`${check ? "  " : "fixed "}${rel}: ${change}\n`);
  }
}

if (check && problems > 0) {
  process.stderr.write(
    `\n${problems} ${problems === 1 ? "package field is" : "package fields are"} not ready to publish. Run \`node scripts/preparePublish.mjs\` to fix them.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  problems === 0
    ? `All ${manifests.length} packages are ready to publish at ${VERSION}.\n`
    : `\nUpdated ${manifests.length} packages to publish at ${VERSION}.\n`,
);
