#!/usr/bin/env node
// release.mjs - bump every package to one version and publish the set.
//
//   node scripts/release.mjs patch --otp 123456
//   node scripts/release.mjs 0.2.0 --otp 123456 --dry-run
//
// The 34 packages share a single version, so a release is one number
// bumped in the root package.json and propagated by preparePublish.
//
// Two things make this survive a bad run. Publishing happens in
// parallel, because npm's one-time password is good for about thirty
// seconds and 34 sequential publishes outlast it. And a package already
// on the registry at this version is skipped, so a run that half
// finished can be repeated with a fresh password and will pick up only
// what is left.
//
// The skip check is not always right. npm's read path can trail its
// write path by minutes, so a package published moments ago still reads
// as missing. Publishing it again comes back with "cannot publish over
// the previously published versions", which this counts as success,
// because it is the registry saying the version is up.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_MANIFEST = path.join(ROOT, "package.json");

/** How many publishes run at once. Enough to finish inside one password. */
const CONCURRENCY = 10;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    otp: { type: "string" },
    "dry-run": { type: "boolean" },
    "skip-build": { type: "boolean" },
  },
  allowPositionals: true,
});

const bump = positionals[0];
const otp = values.otp;
const dryRun = values["dry-run"] === true;
const skipBuild = values["skip-build"] === true;

if (bump === undefined) {
  fail(
    "Say what to release: patch, minor, major, or an exact version.\n" +
      "  node scripts/release.mjs patch --otp 123456",
  );
}

const current = readJson(ROOT_MANIFEST).version;
const next = resolveVersion(current, bump);

console.log(`${current} -> ${next}\n`);

requireCleanTree();

// The version lives in the root manifest; preparePublish copies it to
// every package and repoints their dependencies on each other.
writeVersion(next);
run("node", [path.join(ROOT, "scripts", "preparePublish.mjs")]);

if (!skipBuild) {
  console.log("\nBuilding...");
  run("npm", ["run", "build"]);
}

const packages = findPackages().map((dir) => ({
  dir,
  name: readJson(path.join(dir, "package.json")).name,
}));

console.log(
  `\nChecking which of ${packages.length} packages are already at ${next}...`,
);
const pending = packages.filter(({ name }) => !isPublished(name, next));
const skipped = packages.length - pending.length;
if (skipped > 0) {
  console.log(`${skipped} already published at ${next}, skipping those.`);
}

if (pending.length === 0) {
  console.log(`\nEverything is already on the registry at ${next}.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`\nWould publish ${pending.length} packages:`);
  for (const { name } of pending) {
    console.log(`  ${name}`);
  }
  process.exit(0);
}

if (otp === undefined && requiresOtp()) {
  fail(
    "npm wants a one-time password to publish.\n" +
      `  node scripts/release.mjs ${bump} --otp <code from your authenticator>\n\n` +
      "Read the code as late as you can: publishing has to finish inside its window.",
  );
}

console.log(`\nPublishing ${pending.length} packages...`);
const results = await publishAll(pending);

const failures = results.filter((r) => !r.ok);
for (const { name, message } of failures) {
  console.error(`  failed  ${name}: ${message}`);
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} of ${pending.length} did not publish. The ones that` +
      ` did are on the registry at ${next}.\nRe-run the same command with a` +
      " fresh --otp; it will pick up only what is left.",
  );
  process.exit(1);
}

const alreadyThere = results.filter((r) => r.alreadyThere).length;
console.log(
  `\nPublished ${pending.length - alreadyThere} packages at ${next}.` +
    (alreadyThere > 0
      ? ` ${alreadyThere} were already up from an earlier run.`
      : ""),
);
console.log(
  `\nStill to do:\n  git commit -am "chore: release ${next}"\n  git tag v${next}\n  git push --follow-tags`,
);

// ---------------------------------------------------------------------

function resolveVersion(from, request) {
  const steps = {
    major: ([major]) => [major + 1, 0, 0],
    minor: ([major, minor]) => [major, minor + 1, 0],
    patch: ([major, minor, patch]) => [major, minor, patch + 1],
  };

  const step = steps[request];
  if (step === undefined) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(request)) {
      fail(`"${request}" is not patch, minor, major, or a version like 1.2.3.`);
    }
    return request;
  }

  const parts = from.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    fail(
      `The root version is "${from}", which this cannot bump. Pass an exact version.`,
    );
  }
  return step(parts).join(".");
}

function requireCleanTree() {
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty === "") {
    return;
  }
  // A release that includes uncommitted work publishes something no
  // commit describes, and there is no way to get that version back.
  fail(
    "The working tree has uncommitted changes. Commit or stash them first, so" +
      " the release matches a commit.\n\n" +
      dirty,
  );
}

function writeVersion(version) {
  const manifest = readJson(ROOT_MANIFEST);
  manifest.version = version;
  fs.writeFileSync(ROOT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function findPackages() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (fs.existsSync(path.join(child, "package.json"))) {
        found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(path.join(ROOT, "packages"), 0);
  return found.sort();
}

function isPublished(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether this account still needs a password on top of its token. */
function requiresOtp() {
  try {
    const profile = execFileSync("npm", ["profile", "get", "--json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(profile).tfa?.mode === "auth-and-writes";
  } catch {
    // Nothing readable about the account, so let npm be the judge.
    return false;
  }
}

async function publishAll(pending) {
  const queue = [...pending];
  const results = [];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      const result = await publishOne(item);
      results.push(result);
      done += 1;
      process.stdout.write(
        `  ${label(result)} ${result.name}  (${done}/${pending.length})\n`,
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
  return results;
}

function label(result) {
  if (!result.ok) {
    return "failed     ";
  }
  return result.alreadyThere ? "already up " : "published  ";
}

function publishOne({ dir, name }) {
  const publishArgs = ["publish", "--access", "public"];
  if (otp !== undefined) {
    publishArgs.push("--otp", otp);
  }

  return new Promise((resolve) => {
    const child = spawn("npm", publishArgs, { cwd: dir, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("error", (err) =>
      resolve({ name, ok: false, message: String(err) }),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ name, ok: true });
        return;
      }
      // The registry refuses to overwrite a version, and that refusal is
      // proof the version is up. It comes back on a retry because npm's
      // read path can trail its write path by several minutes, so the
      // skip check above still thinks the package is missing.
      if (/cannot publish over/.test(output)) {
        resolve({ name, ok: true, alreadyThere: true });
        return;
      }
      const line =
        output.split("\n").find((l) => /npm error (?:code |4|5)/.test(l)) ??
        output.split("\n").slice(-2)[0] ??
        `exit ${code}`;
      resolve({
        name,
        ok: false,
        message: line.replace(/^npm error /, "").trim(),
      });
    });
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(bin, runArgs) {
  execFileSync(bin, runArgs, { cwd: ROOT, stdio: "inherit" });
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}
