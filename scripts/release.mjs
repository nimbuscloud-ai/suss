#!/usr/bin/env node
// release.mjs - publish every package at the version already committed.
//
//   node scripts/release.mjs --otp 123456
//   node scripts/release.mjs --dry-run
//
// The version comes out of the root package.json and nothing here
// changes it. Someone bumps it with `npm run bump` and commits that, so
// what reaches the registry is a number a pull request approved rather
// than one a workflow worked out on the runner.
//
// On Actions there is no password to type: npm mints a credential from
// the workflow's OIDC token, and there is no stored token behind it. The
// job's ability to mint one is checked before anything is written,
// because without it all 38 publishes fail with ENEEDAUTH and npm's
// error code alone does not say why. --verbose passes --loglevel verbose
// down to npm, the only place it accounts for the token exchange.
//
// The 38 packages share a single version, which preparePublish copies
// out of the root package.json into each of them.
//
// Two things make this survive a bad run. Publishing happens in
// parallel, because npm's one-time password is good for about thirty
// seconds and 38 sequential publishes outlast it. And a package already
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
    verbose: { type: "boolean" },
  },
  allowPositionals: true,
});

const otp = values.otp;
const dryRun = values["dry-run"] === true;
const skipBuild = values["skip-build"] === true;
const verbose = values.verbose === true;

/** Whether this is the release workflow rather than someone's terminal. */
const onActions = process.env.GITHUB_ACTIONS === "true";

if (positionals.length > 0) {
  fail(
    `This publishes the committed version, so it takes no "${positionals[0]}".\n` +
      "  npm run bump patch     to raise the version, then commit it\n" +
      "  node scripts/release.mjs --otp 123456",
  );
}

const version = readJson(ROOT_MANIFEST).version;

console.log(`Releasing ${version}.\n`);

requireCleanTree();
requirePreparedManifests();

// Before 38 publishes are attempted, and while the message can still
// name the one thing that is missing. A dry run reports the same thing
// without stopping, so a rehearsal that says 38 packages would publish
// is not one that would have failed on auth.
checkPublishCredential({ fatal: !dryRun });

if (!skipBuild) {
  console.log("\nBuilding...");
  run("npm", ["run", "build"]);
}

const packages = findPackages().map((dir) => ({
  dir,
  name: readJson(path.join(dir, "package.json")).name,
}));

console.log(
  `\nChecking which of ${packages.length} packages are already at ${version}...`,
);
const pending = packages.filter(({ name }) => !isPublished(name, version));
const skipped = packages.length - pending.length;
if (skipped > 0) {
  console.log(`${skipped} already published at ${version}, skipping those.`);
}

if (pending.length === 0) {
  console.log(`\nEverything is already on the registry at ${version}.`);
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
      "  node scripts/release.mjs --otp <code from your authenticator>\n\n" +
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
  // The summary above is a grep for npm's error code, which is enough
  // when publishes fail one at a time for their own reasons. When they
  // all fail the same way the cause is upstream of any one package, and
  // the code on its own says nothing, so one transcript goes out whole.
  const [first] = failures;
  console.error(`\n--- npm output for ${first.name} ---`);
  console.error(first.output.trimEnd());
  console.error(`--- end ${first.name} ---`);
  if (failures.length > 1) {
    console.error(
      failures.every((f) => f.message === first.message)
        ? `The other ${failures.length - 1} failed the same way.`
        : `${failures.length - 1} others failed, not all alike; the codes are above.`,
    );
  }

  explainFailures(failures);

  console.error(
    `\n${failures.length} of ${pending.length} did not publish. The ones that` +
      ` did are on the registry at ${version}.\n${
        onActions
          ? "Re-run this workflow; it will pick up only what is left."
          : "Re-run the same command with a fresh --otp; it will pick up only" +
            " what is left."
      }`,
  );
  process.exit(1);
}

const alreadyThere = results.filter((r) => r.alreadyThere).length;
console.log(
  `\nPublished ${pending.length - alreadyThere} packages at ${version}.` +
    (alreadyThere > 0
      ? ` ${alreadyThere} were already up from an earlier run.`
      : ""),
);
if (!onActions) {
  console.log(
    "\nStill to do: tag the commit these came from and write up the release.\n" +
      "The notes go to /tmp, because an untracked file in the tree would" +
      " stop the next release.\n" +
      `  node scripts/changelog.mjs --version ${version} --output /tmp/notes.md\n` +
      `  git tag -a v${version} -m v${version} && git push origin v${version}\n` +
      `  gh release create v${version} --title v${version} --notes-file /tmp/notes.md`,
  );
}

// ---------------------------------------------------------------------

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

/**
 * Whether the packages agree with the root version and with each other.
 *
 * `npm run bump` leaves them that way. Somebody who edited the root
 * version by hand did not, and the packages would go out at whatever
 * they still say, which is the version already on the registry.
 */
function requirePreparedManifests() {
  try {
    execFileSync(
      "node",
      [path.join(ROOT, "scripts", "preparePublish.mjs"), "--check"],
      { cwd: ROOT, stdio: "inherit" },
    );
  } catch {
    fail(
      `The packages do not all say ${version}. Run \`npm run bump ${version}\` and` +
        " commit what it changes.",
    );
  }
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

/**
 * Whether npm has any way to prove who it is, and stop now if it has none.
 *
 * Only decidable on Actions. On a laptop the credential lives in
 * ~/.npmrc, which this cannot read the way npm layers it, so npm stays
 * the judge there.
 */
function checkPublishCredential({ fatal }) {
  if (!onActions) {
    return;
  }

  // npm mints a short-lived credential from these, one per package, and
  // only for packages that name this workflow as a trusted publisher.
  // There is no token behind them, by choice.
  if (
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== undefined
  ) {
    console.log("Credential: trusted publishing.");
    return;
  }

  const message =
    "the job cannot mint an OIDC token, so npm would have nothing to" +
    " publish with and all of it would fail with ENEEDAUTH.\n\n" +
    "`permissions: id-token: write` on the job is what allows it. Without" +
    " that, GitHub sets neither ACTIONS_ID_TOKEN_REQUEST_URL nor" +
    " ACTIONS_ID_TOKEN_REQUEST_TOKEN, and npm skips the exchange without" +
    " saying so.";

  if (fatal) {
    fail(message.charAt(0).toUpperCase() + message.slice(1));
  }
  console.log(`\nNot publishing, but note: ${message}\n`);
}

/** Say what a wall of identical failures is actually about. */
function explainFailures(failures) {
  if (!failures.every(({ message }) => message.includes("ENEEDAUTH"))) {
    return;
  }
  console.error(
    "\nENEEDAUTH is npm having no credential at all, not one being refused.",
  );
  if (!onActions) {
    console.error("Run `npm login` first.");
    return;
  }
  console.error(
    "Trusted publishing hands out a credential per package, and only to\n" +
      "packages that name this repository and this workflow on npmjs.com,\n" +
      "under the package's Settings. One never set up there gets nothing,\n" +
      "and there is no token behind it to fall back on." +
      (verbose
        ? ""
        : "\n\nRe-run with --verbose for npm's own account of the exchange."),
  );
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
  // npm accounts for the OIDC token exchange at verbose and nowhere else,
  // so this is the only way to see why it came back with nothing. The
  // output is captured and printed only on failure, so it costs nothing.
  if (verbose) {
    publishArgs.push("--loglevel", "verbose");
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
      resolve({ name, ok: false, message: String(err), output: String(err) }),
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
        output,
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
