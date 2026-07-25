#!/usr/bin/env node
// preparePublish.mjs — put every workspace package into a publishable
// state, and keep them there.
//
// Three things have to hold before `npm publish` does the right thing:
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
//
// Run with --check to assert all three without writing, which is what
// CI does. Run without arguments to fix them.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

/** The version every package publishes at. One number for the whole set. */
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

function findManifests(dir, depth = 0) {
  if (depth > 3) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
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
    changes.push(`version ${pkg.version} should be ${VERSION}`);
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

  for (const field of ["dependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps === undefined) {
      continue;
    }
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@suss/") || range === VERSION) {
        continue;
      }
      changes.push(`${field}.${name} is "${range}"`);
      if (write) {
        deps[name] = VERSION;
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

for (const manifest of manifests) {
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
