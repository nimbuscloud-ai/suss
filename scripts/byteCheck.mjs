/**
 * byteCheck.mjs: extract the same inputs with two builds of suss and say
 * whether they wrote the same summaries, byte for byte.
 *
 *   npm run byte-check                            origin/main's build against this checkout's
 *   node scripts/byteCheck.mjs --quick            leave out the field apps
 *   node scripts/byteCheck.mjs --self             origin/main's build against itself
 *   node scripts/byteCheck.mjs --extra all        add the apps for one library each
 *   node scripts/byteCheck.mjs --main <bin.js | ref> --branch <bin.js>
 *
 * Each extract runs with --no-cache and prints its time and peak memory.
 * The run exits non-zero when any input differs or fails. CONTRIBUTING.md
 * has the details: which build is which, field clones, and --expect.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  EXTRA_INPUTS,
  FIELD_INPUTS,
  FIXTURE_INPUTS,
  SELF_INPUTS,
} from "./byteCheckInputs.mjs";
import {
  binFor,
  buildAt,
  describeBuild,
  git,
  heapFlags,
} from "./comparisonBuild.mjs";
import { loadPerCore, percent, settle } from "./machineLoad.mjs";
import { ROOT } from "./workspacePackages.mjs";

const PEAK_HOOK = path.join(ROOT, "scripts", "peakMemory.cjs");
// The first-run scorecard apps, then the apps that each exercise one
// library, which stay out of the scorecard so its count stays comparable.
const REPO_LISTS = ["repos.json", "libraryRepos.json"].map((name) =>
  path.join(ROOT, "tools", "first-run", name),
);

// The largest field extract takes about two minutes. One that runs ten
// times longer has hung.
const EXTRACT_TIMEOUT_MS = 20 * 60 * 1000;

// Another extract running beside a field app slows both, so each field
// app waits a while for the load to fall first.
const FIELD_LOAD_PER_CORE = 0.5;
const FIELD_SETTLE_MS = 5 * 60 * 1000;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    main: { type: "string", default: "origin/main" },
    branch: { type: "string" },
    self: { type: "boolean" },
    fetch: { type: "boolean" },
    "build-only": { type: "boolean" },
    quick: { type: "boolean" },
    extra: { type: "string" },
    only: { type: "string" },
    expect: { type: "string" },
    out: {
      type: "string",
      default: path.join(os.tmpdir(), "suss-byte-check"),
    },
    "repos-dir": {
      type: "string",
      default: path.join(os.homedir(), ".cache", "suss-first-run", "repos"),
    },
    list: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const USAGE = `byteCheck.mjs: extract the same inputs with two builds and compare the summaries

  --main <bin.js | ref>  the build to compare against: a CLI's bin.js, or a git
                         ref built in a worktree of its own (default origin/main)
  --branch <bin.js>      the build under test (default this checkout's)
  --self                 compare the main build with itself
  --fetch                git fetch origin before building a ref
  --build-only           build --main and print where its CLI is, then stop
  --quick                leave out the field apps
  --extra <a,b | all>    add apps that each exercise one library: ${EXTRA_INPUTS.map((i) => i.name).join(", ")}
  --only <a,b>           run the inputs whose name contains one of these
  --expect <text>        refuse to run unless only the branch's dist contains <text>
  --out <dir>            where both builds write their summaries (default ${path.join(os.tmpdir(), "suss-byte-check")})
  --repos-dir <dir>      the first-run clones (default ~/.cache/suss-first-run/repos)
  --list                 print each input's command and stop
`;

if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/** A build given as a bin.js: a suss checkout's, or an installed CLI's. */
function buildFromBin(bin, label) {
  const checkout = path.resolve(path.dirname(bin), "..", "..", "..");
  const isCheckout =
    fs.existsSync(path.join(checkout, "packages", "cli", "package.json")) &&
    fs.existsSync(path.join(checkout, ".git"));
  if (isCheckout) {
    return { ...describeBuild(checkout, label), bin };
  }
  return { label, dir: null, sha: "installed", dirty: false, bin };
}

function resolveBuild(spec, label) {
  if (spec.endsWith(".js")) {
    if (!fs.existsSync(spec)) {
      fail(`No CLI at ${spec}.`);
    }
    return buildFromBin(path.resolve(spec), label);
  }
  if (values.fetch === true) {
    git(["fetch", "--quiet", "origin"]);
  }
  const built = buildAt(spec);
  return { ...built, label, bin: binFor(built.dir) };
}

/** Every built JavaScript file the CLI can load from this build. */
function distFiles(build) {
  const root =
    build.dir === null
      ? path.resolve(path.dirname(build.bin), "..", "..")
      : path.join(build.dir, "packages");
  const files = [];
  collectDistFiles(root, false, files);
  return files.sort();
}

function collectDistFiles(dir, insideDist, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDistFiles(full, insideDist || entry.name === "dist", files);
      continue;
    }
    if (insideDist && /\.[cm]?js$/.test(entry.name)) {
      files.push(full);
    }
  }
}

/** A short hash of a build's dist, so a run can tell two builds apart. */
function fingerprint(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex").slice(0, 12);
}

function containsText(files, text) {
  return files.some((file) => fs.readFileSync(file, "utf8").includes(text));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function selectedInputs() {
  const all = [
    ...FIXTURE_INPUTS,
    ...SELF_INPUTS,
    ...(values.quick === true ? [] : FIELD_INPUTS),
    ...extraInputs(),
  ];
  if (values.only === undefined) {
    return all;
  }
  const wanted = values.only.split(",").map((s) => s.trim());
  return all.filter((input) => wanted.some((w) => input.name.includes(w)));
}

function extraInputs() {
  if (values.extra === undefined) {
    return [];
  }
  if (values.extra === "all") {
    return EXTRA_INPUTS;
  }
  const wanted = values.extra.split(",").map((s) => s.trim());
  const unknown = wanted.filter(
    (w) => !EXTRA_INPUTS.some((input) => input.name === w),
  );
  if (unknown.length > 0) {
    fail(
      `No extra input named ${unknown.join(", ")}. Known: ${EXTRA_INPUTS.map((i) => i.name).join(", ")}.`,
    );
  }
  return EXTRA_INPUTS.filter((input) => wanted.includes(input.name));
}

/** Fixture directories the input list does not cover. */
function fixturesWithoutInput() {
  const covered = new Set(
    FIXTURE_INPUTS.map((input) => input.name.split("/")[1]),
  );
  return fs
    .readdirSync(path.join(ROOT, "fixtures"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !covered.has(entry.name))
    .map((entry) => entry.name);
}

function slugOf(input) {
  return input.name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function resolveOptions(value, base) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveOptions(item, base));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (typeof value.inBase === "string") {
    return path.join(base, value.inBase);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveOptions(item, base),
    ]),
  );
}

/** The input's arguments, with each `withConfig` written to a file. */
function argumentsFor(input, base) {
  const configDir = path.join(values.out, "configs", slugOf(input));
  return input.args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, `suss.${arg.pack}.json`);
    const options = resolveOptions(arg.options, base);
    fs.writeFileSync(file, `${JSON.stringify(options, null, 2)}\n`);
    return `${arg.pack}=${file}`;
  });
}

function describeArg(arg) {
  return typeof arg === "string"
    ? arg
    : `${arg.pack}=${JSON.stringify(arg.options)}`;
}

// ---------------------------------------------------------------------------
// Field clones
// ---------------------------------------------------------------------------

const PINNED = new Map(
  REPO_LISTS.flatMap((file) =>
    JSON.parse(fs.readFileSync(file, "utf8")).map((entry) => [
      entry.name,
      { ...entry, list: path.relative(ROOT, file) },
    ]),
  ),
);

function headOf(dir) {
  const res = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Where the clone is, or why it cannot be read at its pinned commit. */
function cloneOf(input) {
  const pinned = PINNED.get(input.repo);
  if (pinned === undefined) {
    return {
      problem: `${input.repo} is in neither tools/first-run/repos.json nor tools/first-run/libraryRepos.json`,
    };
  }
  const dir = path.join(values["repos-dir"], input.repo);
  if (!fs.existsSync(dir)) {
    return {
      problem:
        `no clone at ${dir}. Make one with \`npx tsx tools/first-run/src/run.ts ` +
        `--work <dir> --cli <suss> --repos ${pinned.list} --only ${input.repo}\`, where <dir>/repos is ${values["repos-dir"]}`,
    };
  }
  const head = headOf(dir);
  if (head !== pinned.commit) {
    return {
      problem:
        `the clone is at ${head?.slice(0, 10) ?? "no commit"}, not the pinned ${pinned.commit.slice(0, 10)}. ` +
        "A first-run may be reading its parent commit right now",
    };
  }
  return { dir, commit: pinned.commit };
}

// ---------------------------------------------------------------------------
// One extract
// ---------------------------------------------------------------------------

function summaryCount(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    return Array.isArray(parsed.summaries) ? parsed.summaries.length : null;
  } catch {
    return null;
  }
}

function readPeak(file) {
  try {
    return Number(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runOnce(input, build, base, args, nodeFlags) {
  const outFile = path.join(values.out, build.label, `${slugOf(input)}.json`);
  const peakFile = `${outFile}.peak`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  fs.rmSync(peakFile, { force: true });

  const command = input.command ?? "extract";
  const cache = command === "extract" ? ["--no-cache"] : [];
  const argv = [
    ...nodeFlags,
    "--require",
    PEAK_HOOK,
    build.bin,
    command,
    ...args,
    ...cache,
    "-o",
    outFile,
  ];
  const started = performance.now();
  const res = spawnSync(process.execPath, argv, {
    cwd: base,
    env: { ...process.env, PEAK_MEMORY_FILE: peakFile },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: EXTRACT_TIMEOUT_MS,
  });
  const wallMs = performance.now() - started;
  const peakBytes = readPeak(peakFile);
  fs.rmSync(peakFile, { force: true });
  return {
    outFile,
    exit: res.status,
    timedOut: res.error?.code === "ETIMEDOUT",
    wallMs,
    peakBytes,
    summaries: fs.existsSync(outFile) ? summaryCount(outFile) : null,
    stderrTail: (res.stderr ?? "").trim().split("\n").slice(-6).join("\n"),
  };
}

function runFailure(run) {
  if (run.timedOut) {
    return `timed out after ${seconds(EXTRACT_TIMEOUT_MS)}`;
  }
  if (run.exit !== 0) {
    return `exit ${run.exit}: ${run.stderrTail}`;
  }
  if (!fs.existsSync(run.outFile)) {
    return "wrote no output";
  }
  return null;
}

/** The first byte where two files part, with a little of each around it. */
function compareOutputs(left, right) {
  const a = fs.readFileSync(left);
  const b = fs.readFileSync(right);
  if (a.equals(b)) {
    return null;
  }
  const limit = Math.min(a.length, b.length);
  let offset = 0;
  while (offset < limit && a[offset] === b[offset]) {
    offset++;
  }
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (a[i] === 0x0a) {
      line++;
    }
  }
  const around = (buf) =>
    buf
      .subarray(Math.max(0, offset - 60), offset + 60)
      .toString("utf8")
      .replace(/\s+/g, " ");
  return { offset, line, context: [around(a), around(b)] };
}

function prepare(input, base) {
  if (input.prepare === undefined) {
    return null;
  }
  const [command, ...args] = input.prepare;
  const res = spawnSync(command, args, { cwd: base, encoding: "utf8" });
  if (res.status !== 0) {
    const tail = (res.stderr ?? "").trim().split("\n").slice(-4).join(" ");
    return `${input.prepare.join(" ")} failed: ${tail}`;
  }
  return null;
}

/** What the two runs of one input amount to. */
function verdict(runs, base) {
  const failures = [...runs]
    .map(([label, run]) => [label, runFailure(run)])
    .filter(([, failure]) => failure !== null);
  if (failures.length > 0) {
    return {
      status: "failed",
      reason: failures.map(([label, f]) => `${label} ${f}`).join("; "),
    };
  }
  if (base.commit !== undefined && headOf(base.dir) !== base.commit) {
    return {
      status: "moved",
      reason: "the clone changed commit during the run",
    };
  }
  const [left, right] = [...runs.values()].map((run) => run.outFile);
  const diff = compareOutputs(left, right);
  return diff === null ? { status: "identical" } : { status: "differs", diff };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function megabytes(bytes) {
  return bytes === null ? "?" : `${Math.round(bytes / (1024 * 1024))}MB`;
}

const RESULT_TEXT = {
  identical: () => "identical",
  differs: (r) => `DIFFERS at byte ${r.diff.offset}, line ${r.diff.line}`,
  failed: (r) => `FAILED: ${r.reason}`,
  missing: (r) => `NOT CHECKED: ${r.reason}`,
  moved: (r) => `NOT CHECKED: ${r.reason}`,
  skipped: (r) => `skipped: ${r.reason}`,
};

const FAILING = new Set(["differs", "failed", "missing", "moved"]);

/** One line of the table: time and peak memory for each build, then the result. */
function row(name, summaries, cells, result) {
  const columns = [...cells, "", "", "", ""]
    .slice(0, 4)
    .map((cell) => cell.padStart(10))
    .join(" ");
  return `${name.padEnd(44)} ${String(summaries ?? "").padStart(9)} ${columns}  ${result}\n`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const missingFixtures = fixturesWithoutInput();
if (missingFixtures.length > 0) {
  fail(
    `These fixtures have no input in scripts/byteCheckInputs.mjs: ${missingFixtures.join(", ")}. ` +
      "Add each one with the packs its tests use.",
  );
}

const inputs = selectedInputs();
if (inputs.length === 0) {
  fail(`No input matches --only ${values.only}.`);
}

if (values.list === true) {
  for (const input of inputs) {
    const command = input.command ?? "extract";
    process.stdout.write(
      `${input.name}\n    ${input.group}: suss ${command} ${input.args.map(describeArg).join(" ")}\n`,
    );
  }
  process.exit(0);
}

const main = resolveBuild(values.main, "main");
if (values["build-only"] === true) {
  process.stdout.write(`${main.bin}\n`);
  process.exit(0);
}

const branch =
  values.self === true
    ? { ...main, label: "again" }
    : buildFromBin(path.resolve(values.branch ?? binFor(ROOT)), "branch");
if (!fs.existsSync(branch.bin)) {
  fail(`No CLI at ${branch.bin}. Run \`npm run build\` first.`);
}
const builds = [main, branch];

const mainDist = distFiles(main);
const branchDist = values.self === true ? mainDist : distFiles(branch);
if (values.expect !== undefined) {
  if (values.self === true) {
    fail("--expect compares two builds, and --self runs one.");
  }
  const onlyBranch =
    containsText(branchDist, values.expect) &&
    !containsText(mainDist, values.expect);
  if (!onlyBranch) {
    fail(
      `Expected "${values.expect}" in the branch's dist and not in main's. ` +
        "One of the two builds is not the one you meant. Rebuild it and run again.",
    );
  }
}

const prints = [fingerprint(mainDist), fingerprint(branchDist)];
for (const [i, build] of builds.entries()) {
  process.stderr.write(
    `${build.label.padEnd(10)} ${build.sha}${build.dirty ? " (dirty)" : ""}, dist ${prints[i]}, ${build.bin}\n`,
  );
}
if (values.self !== true && prints[0] === prints[1]) {
  process.stderr.write(
    "note: both builds have the same dist. Unless the branch changes nothing that is built, one of them was not rebuilt.\n",
  );
}

// Both builds read suss's own packages from main's checkout, so a package
// the branch edits does not differ by its own edit.
const selfRoot = main.dir ?? ROOT;
if (main.dir === null && inputs.some((input) => input.group === "self")) {
  process.stderr.write(
    "note: the main build is not a checkout, so suss's own packages are read from this one. A package the branch edits differs by its own edit.\n",
  );
}

const BASE_OF = {
  fixtures: () => ({ dir: ROOT }),
  self: () => ({ dir: selfRoot }),
  field: cloneOf,
  extra: cloneOf,
};

for (const build of builds) {
  fs.rmSync(path.join(values.out, build.label), {
    recursive: true,
    force: true,
  });
}
fs.rmSync(path.join(values.out, "configs"), { recursive: true, force: true });

const nodeFlags = await heapFlags();
process.stderr.write(
  `Comparing ${inputs.length} inputs on ${os.cpus().length} cores, load ${percent(loadPerCore())} per core.\n\n`,
);
process.stdout.write(
  row(
    "input",
    "summaries",
    ["main", branch.label, "main mem", `${branch.label} mem`],
    "result",
  ),
);

const results = [];
for (const [index, input] of inputs.entries()) {
  const base = BASE_OF[input.group](input);
  const result = { name: input.name, group: input.group };
  results.push(result);

  if (base.problem !== undefined) {
    result.status = input.group === "extra" ? "skipped" : "missing";
    result.reason = base.problem;
    process.stdout.write(
      row(input.name, null, [], RESULT_TEXT[result.status](result)),
    );
    continue;
  }

  if (input.group === "field" || input.group === "extra") {
    result.loadPerCore = settle({
      maxLoadPerCore: FIELD_LOAD_PER_CORE,
      limitMs: FIELD_SETTLE_MS,
    });
    process.stderr.write(
      `  ${input.name}: load ${percent(result.loadPerCore)} per core\n`,
    );
  }

  const prepared = prepare(input, base.dir);
  if (prepared !== null) {
    result.status = "failed";
    result.reason = prepared;
    process.stdout.write(row(input.name, null, [], RESULT_TEXT.failed(result)));
    continue;
  }

  const args = argumentsFor(input, base.dir);
  // Alternating which build goes first keeps a warm file cache from
  // landing on one side every time.
  const order = index % 2 === 0 ? builds : [branch, main];
  const byLabel = new Map(
    order.map((build) => [
      build.label,
      runOnce(input, build, base.dir, args, nodeFlags),
    ]),
  );
  const runs = new Map(
    builds.map((build) => [build.label, byLabel.get(build.label)]),
  );
  Object.assign(result, verdict(runs, base));
  result.runs = Object.fromEntries(runs);

  const [mainRun, branchRun] = runs.values();
  const summaries =
    mainRun.summaries === branchRun.summaries
      ? mainRun.summaries
      : `${mainRun.summaries}/${branchRun.summaries}`;
  const cells = [
    seconds(mainRun.wallMs),
    seconds(branchRun.wallMs),
    megabytes(mainRun.peakBytes),
    megabytes(branchRun.peakBytes),
  ];
  process.stdout.write(
    row(input.name, summaries, cells, RESULT_TEXT[result.status](result)),
  );
  if (result.status === "differs") {
    process.stdout.write(
      `    main:   ${result.diff.context[0]}\n    ${branch.label}: ${result.diff.context[1]}\n`,
    );
  }
}

const counts = {};
for (const result of results) {
  counts[result.status] = (counts[result.status] ?? 0) + 1;
}
fs.writeFileSync(
  path.join(values.out, "report.json"),
  `${JSON.stringify({ builds, dist: prints, nodeFlags, results }, null, 2)}\n`,
);
const tally = Object.entries(counts)
  .map(([status, count]) => `${count} ${status}`)
  .join(", ");
process.stdout.write(
  `\n${inputs.length} inputs: ${tally}. Summaries are in ${path.join(values.out, main.label)} and ${path.join(values.out, branch.label)}.\n`,
);

if (results.some((result) => FAILING.has(result.status))) {
  process.exit(1);
}
