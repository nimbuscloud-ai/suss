// checkPerfBaseline.mjs
//
// Measure what running suss costs, compare against the baseline
// committed at scripts/perf-baseline.json, and fail past the
// thresholds below. Three things are measured:
//
//   fixtures   The built CLI extracts a fixed list of targets under
//              fixtures/, one process per target, cache off. Small
//              projects, roughly one per pack family, so a pack that
//              gets slower shows up even when the dogfood corpus never
//              exercises it.
//   dogfood    scripts/dogfood.mjs over every @suss/* package, the
//              same run CI does, with the extraction caches cleared
//              first so every repeat measures a cold extraction.
//   sizes      npm pack --dry-run per workspace package, the tarball
//              npm would publish.
//
// Wall time on a shared runner is noisy, and the committed baseline
// may come from a different machine class than the runner comparing
// against it. So the gate never compares seconds to seconds: a fixed
// arithmetic loop is timed in the same run, each workload's wall time
// is divided by it, and the gate fails when that normalized figure
// exceeds twice the baseline's. Peak RSS does not scale with machine
// speed, so it gates on the raw ratio, also at twice the baseline.
// Package sizes are deterministic and gate tight: a package fails when
// its packed tarball grows more than 15% or 250KB over baseline,
// whichever allowance is larger.
//
// Usage, after `npm run build`:
//
//   node scripts/checkPerfBaseline.mjs              measure and compare
//   node scripts/checkPerfBaseline.mjs --update     rewrite the baseline
//   node scripts/checkPerfBaseline.mjs --repeats 3  more repeats
//
// Refreshing the baseline is a deliberate commit, same as the other
// baselines: run with --update and put the diff in a pull request. A
// run also rewrites scripts/dogfood-baseline.json and the per-package
// .suss outputs, the same way `npm run dogfood` does.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { printDelta, reportRegressions } from "./baselineCompare.mjs";
import { ROOT, readWorkspacePackages } from "./workspacePackages.mjs";

const BASELINE_REL_PATH = "scripts/perf-baseline.json";
const BASELINE_PATH = path.join(ROOT, BASELINE_REL_PATH);
const CLI_BIN = path.join(ROOT, "packages", "cli", "dist", "bin.js");

const WALL_RATIO_LIMIT = 2;
const RSS_RATIO_LIMIT = 2;
const SIZE_GROWTH_FRACTION = 0.15;
const SIZE_GROWTH_FLOOR_BYTES = 250 * 1024;
const RSS_SAMPLE_MS = 100;

// Dogfood normally takes a worker per core, which makes its peak RSS a
// function of the machine rather than of the code: a 12-core laptop
// holds three times as many concurrent extractions in memory as the
// 4-core runner comparing against its baseline. Pinning the worker
// count to the CI runner's class makes the peak comparable anywhere.
const DOGFOOD_WORKERS = 4;

// A fixed list rather than a walk of fixtures/, so adding a fixture
// never silently inflates the aggregate this gate compares. Growing the
// list is a deliberate baseline refresh, like any other change here.
//
// What the list leaves out, and why. The prisma fixture extracts
// nothing without the discovery pack its integration test defines
// inline, and drizzle's fixture lives in memory, so neither gives the
// CLI a target. The apollo fixture would work, and axios has no
// fixture yet; both can join on a baseline refresh. Storybook,
// appsync, and aws-apigateway are contract packs exercised through
// `suss contract`, which this workload does not measure. The Python
// fixtures stay out because the CLI extract path only loads the
// TypeScript adapter.
const FIXTURE_TARGETS = [
  { name: "express", dir: "fixtures/express", packs: ["express"] },
  { name: "fastify", dir: "fixtures/fastify", packs: ["fastify"] },
  { name: "hono", dir: "fixtures/hono", packs: ["hono"] },
  { name: "nestjs-rest", dir: "fixtures/nestjs-rest", packs: ["nestjs-rest"] },
  {
    name: "nestjs-graphql",
    dir: "fixtures/nestjs-graphql",
    packs: ["nestjs-graphql"],
  },
  { name: "nextjs", dir: "fixtures/nextjs", packs: ["nextjs"] },
  { name: "react", dir: "fixtures/react", packs: ["react"] },
  {
    name: "react-router",
    dir: "fixtures/react-router",
    packs: ["react-router"],
  },
  { name: "ts-rest", dir: "fixtures/ts-rest", packs: ["ts-rest"] },
  { name: "fetch", dir: "fixtures/fetch", packs: ["fetch"] },
  {
    name: "apollo-client",
    dir: "fixtures/apollo-client",
    packs: ["apollo-client"],
  },
  // The aws fixtures carry a SAM template, and the aws-lambda pack is
  // what discovers their handlers; alone, the producer packs would have
  // no unit bodies to look inside.
  {
    name: "aws-sqs",
    tsconfig: "fixtures/aws-sqs/tsconfig.json",
    packs: ["aws-lambda", "aws-sqs"],
  },
  {
    name: "aws-eventbridge",
    tsconfig: "fixtures/aws-eventbridge/tsconfig.json",
    packs: ["aws-lambda", "aws-eventbridge"],
  },
];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    update: { type: "boolean" },
    repeats: { type: "string", default: "2" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help === true) {
  process.stdout.write(
    `checkPerfBaseline.mjs: measure suss's cost and compare against ${BASELINE_REL_PATH}

  --update       rewrite the baseline with this run's numbers
  --repeats <n>  workload repeats, default 2; wall takes the min, RSS the max
`,
  );
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1) {
  fail(`--repeats takes a whole number of runs. It got "${values.repeats}".`);
}

// ---------------------------------------------------------------------------
// Machine state
// ---------------------------------------------------------------------------

// One core's arithmetic throughput. Dividing a wall time by this cancels
// most of the difference between the machine that wrote the baseline and
// the machine comparing against it.
function calibrationSampleMs() {
  const start = performance.now();
  let acc = 0;
  for (let i = 1; i <= 20_000_000; i++) {
    acc += Math.sqrt(i) % 7;
  }
  if (acc < 0) {
    throw new Error("calibration loop was optimised away");
  }
  return performance.now() - start;
}

function bestCalibration(samples) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    best = Math.min(best, calibrationSampleMs());
  }
  return best;
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function npmVersion() {
  return execFileSync("npm", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// So a surprising failure says what hardware wrote each side's numbers
// before anyone starts bisecting the code.
function describeMachine(record) {
  return `${record.cpu ?? "?"} (${record.arch ?? "?"}, ${record.cores ?? "?"} cores, npm ${record.npm ?? "?"})`;
}

function warnIfLoaded() {
  const perCore = os.loadavg()[0] / os.cpus().length;
  if (perCore > 0.5) {
    process.stderr.write(
      `Note: load is ${(perCore * 100).toFixed(0)}% per core. Wall times will read high, ` +
        "but so will the calibration loop, and the gate compares their ratio.\n",
    );
  }
}

// ---------------------------------------------------------------------------
// One measured child process
// ---------------------------------------------------------------------------

// VmHWM is the process's own high-water mark, so on Linux one late
// sample is enough. The ps fallback reads instantaneous RSS, and
// sampling it approximates the peak closely enough for a 2x gate.
// The committed baseline came through the fallback, so a Linux run
// reading VmHWM sits slightly high against it before any regression.
// Worker threads share their parent's address space, so one pid covers
// the dogfood run.
function sampleRssBytes(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const hwm = /VmHWM:\s+(\d+) kB/.exec(status);
    if (hwm !== null) {
      return Number(hwm[1]) * 1024;
    }
  } catch {
    // Not Linux, or the process already exited. The fallback answers.
  }
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const kb = Number(out.trim());
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

function runMeasured(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));

    let peakRssBytes = 0;
    const sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, sampleRssBytes(child.pid));
    }, RSS_SAMPLE_MS);

    child.on("error", (err) => {
      clearInterval(sampler);
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(sampler);
      const wallMs = performance.now() - started;
      if (code !== 0) {
        const tail = Buffer.concat(output).toString("utf8").slice(-2000);
        reject(
          new Error(`${command} ${args.join(" ")} exited ${code}:\n${tail}`),
        );
        return;
      }
      resolve({ wallMs, peakRssBytes });
    });
  });
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function runFixturesOnce() {
  const outFile = path.join(os.tmpdir(), `suss-perf-${process.pid}.json`);
  let wallMs = 0;
  let peakRssBytes = 0;
  try {
    for (const target of FIXTURE_TARGETS) {
      const args = [CLI_BIN, "extract"];
      if (target.tsconfig !== undefined) {
        args.push("-p", path.join(ROOT, target.tsconfig));
      } else {
        args.push("--dir", path.join(ROOT, target.dir));
      }
      for (const pack of target.packs) {
        args.push("-f", pack);
      }
      args.push("--no-cache", "-o", outFile);

      const run = await runMeasured(process.execPath, args);
      wallMs += run.wallMs;
      peakRssBytes = Math.max(peakRssBytes, run.peakRssBytes);
    }
  } finally {
    fs.rmSync(outFile, { force: true });
  }
  return { wallMs, peakRssBytes };
}

// A warm cache turns extraction into a lookup, and a lookup is not what
// this gate watches. Clearing costs the next local dogfood run a cold
// start and nothing else; the summaries next to the cache stay.
function clearExtractionCaches() {
  for (const pkg of readWorkspacePackages()) {
    fs.rmSync(path.join(ROOT, pkg.dir, ".suss", "cache"), {
      recursive: true,
      force: true,
    });
  }
}

async function runDogfoodOnce() {
  clearExtractionCaches();
  return runMeasured(
    process.execPath,
    [path.join(ROOT, "scripts/dogfood.mjs")],
    { DOGFOOD_CONCURRENCY: String(DOGFOOD_WORKERS) },
  );
}

// ---------------------------------------------------------------------------
// Package sizes
// ---------------------------------------------------------------------------

function measurePackageSizes() {
  const pkgs = readWorkspacePackages();
  const args = [
    "pack",
    "--dry-run",
    "--json",
    ...pkgs.map((pkg) => `--workspace=${pkg.dir}`),
  ];
  const out = execFileSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const dirByName = new Map(pkgs.map((pkg) => [pkg.name, pkg.dir]));

  const packages = {};
  for (const entry of JSON.parse(out)) {
    const dir = dirByName.get(entry.name);
    if (dir === undefined) {
      fail(`npm pack reported ${entry.name}, which is not in the workspace.`);
    }
    packages[dir] = {
      name: entry.name,
      packedBytes: entry.size,
      unpackedBytes: entry.unpackedSize,
    };
  }
  return Object.fromEntries(
    Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)}kB`;
  }
  return `${n}B`;
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

if (!fs.existsSync(CLI_BIN)) {
  fail("This checkout has no built CLI. Run `npm run build` first.");
}
for (const target of FIXTURE_TARGETS) {
  const entry = path.join(ROOT, target.tsconfig ?? target.dir);
  if (!fs.existsSync(entry)) {
    fail(`Fixture target ${target.name} points at ${entry}, which is gone.`);
  }
}

warnIfLoaded();
process.stderr.write(
  `Measuring ${FIXTURE_TARGETS.length} fixture targets and the dogfood run, ${repeats} repeat(s)...\n`,
);

const calibrations = [bestCalibration(3)];
const fixtureRuns = [];
const dogfoodRuns = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  const fixtures = await runFixturesOnce();
  fixtureRuns.push(fixtures);
  process.stderr.write(
    `  ${repeat}  fixtures ${seconds(fixtures.wallMs)}, peak ${formatBytes(fixtures.peakRssBytes)}\n`,
  );
  calibrations.push(bestCalibration(1));

  const dogfood = await runDogfoodOnce();
  dogfoodRuns.push(dogfood);
  process.stderr.write(
    `  ${repeat}  dogfood  ${seconds(dogfood.wallMs)}, peak ${formatBytes(dogfood.peakRssBytes)}\n`,
  );
  calibrations.push(bestCalibration(1));
}

// Min wall and max RSS, not means: noise only ever adds time, and the
// peak of interest is the largest one any run reached.
function summarise(runs) {
  return {
    wallMs: Math.round(Math.min(...runs.map((r) => r.wallMs))),
    peakRssBytes: Math.max(...runs.map((r) => r.peakRssBytes)),
  };
}

const current = {
  cores: os.cpus().length,
  arch: os.arch(),
  cpu: os.cpus()[0].model,
  npm: npmVersion(),
  calibrationMs: Math.round(median(calibrations)),
  workloads: {
    fixtures: {
      targets: FIXTURE_TARGETS.map((t) => t.name),
      ...summarise(fixtureRuns),
    },
    dogfood: summarise(dogfoodRuns),
  },
  packages: measurePackageSizes(),
};

if (values.update === true) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `Wrote ${BASELINE_REL_PATH}: calibration ${current.calibrationMs}ms, ` +
      `fixtures ${seconds(current.workloads.fixtures.wallMs)} at ${formatBytes(current.workloads.fixtures.peakRssBytes)} peak, ` +
      `dogfood ${seconds(current.workloads.dogfood.wallMs)} at ${formatBytes(current.workloads.dogfood.peakRssBytes)} peak, ` +
      `${Object.keys(current.packages).length} package tarballs. Commit the diff.`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

if (!fs.existsSync(BASELINE_PATH)) {
  fail(
    `${BASELINE_REL_PATH} is missing. Run \`node scripts/checkPerfBaseline.mjs --update\` and commit it.`,
  );
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
const regressions = [];

console.log(
  `\nMachine: ${describeMachine(baseline)} baseline → ${describeMachine(current)} here.`,
);
console.log(
  `Workloads against ${BASELINE_REL_PATH} ` +
    `(calibration ${baseline.calibrationMs}ms baseline → ${current.calibrationMs}ms here):`,
);
for (const [name, cur] of Object.entries(current.workloads)) {
  const base = baseline.workloads?.[name];
  if (base === undefined) {
    console.log(`  ${name}: new since the baseline, nothing to compare`);
    continue;
  }

  const wallRatio =
    cur.wallMs / current.calibrationMs / (base.wallMs / baseline.calibrationMs);
  console.log(
    `  ${name} wall: ${seconds(base.wallMs)} → ${seconds(cur.wallMs)}, ` +
      `normalized ratio ${wallRatio.toFixed(2)} (fails past ${WALL_RATIO_LIMIT.toFixed(2)})`,
  );
  if (wallRatio > WALL_RATIO_LIMIT) {
    regressions.push({
      label: `${name} wall time`,
      detail:
        `${seconds(base.wallMs)} → ${seconds(cur.wallMs)}, ` +
        `${wallRatio.toFixed(2)}x the baseline after calibration, limit ${WALL_RATIO_LIMIT}x`,
    });
  }

  const rssRatio = cur.peakRssBytes / base.peakRssBytes;
  console.log(
    `  ${name} peak RSS: ${formatBytes(base.peakRssBytes)} → ${formatBytes(cur.peakRssBytes)}, ` +
      `ratio ${rssRatio.toFixed(2)} (fails past ${RSS_RATIO_LIMIT.toFixed(2)})`,
  );
  if (rssRatio > RSS_RATIO_LIMIT) {
    regressions.push({
      label: `${name} peak RSS`,
      detail:
        `${formatBytes(base.peakRssBytes)} → ${formatBytes(cur.peakRssBytes)}, ` +
        `${rssRatio.toFixed(2)}x the baseline, limit ${RSS_RATIO_LIMIT}x`,
    });
  }

  if (
    base.targets !== undefined &&
    JSON.stringify(base.targets) !== JSON.stringify(cur.targets)
  ) {
    console.log(
      `  ${name}: the target list changed since the baseline, so the comparison above is loose. Refresh with --update.`,
    );
  }
}

console.log("\nPacked tarball sizes:");
let unchanged = 0;
for (const [dir, cur] of Object.entries(current.packages)) {
  const base = baseline.packages?.[dir];
  if (base === undefined) {
    console.log(
      `  ${cur.name}: new since the baseline, ${formatBytes(cur.packedBytes)}, nothing to compare`,
    );
    continue;
  }
  if (cur.packedBytes === base.packedBytes) {
    unchanged += 1;
    continue;
  }

  printDelta(cur.name, base.packedBytes, cur.packedBytes, formatBytes);
  const allowedGrowth = Math.max(
    base.packedBytes * SIZE_GROWTH_FRACTION,
    SIZE_GROWTH_FLOOR_BYTES,
  );
  if (cur.packedBytes > base.packedBytes + allowedGrowth) {
    regressions.push({
      label: cur.name,
      detail:
        `packed ${formatBytes(base.packedBytes)} → ${formatBytes(cur.packedBytes)}, ` +
        `past the allowed growth of ${formatBytes(allowedGrowth)}`,
    });
  }
}
for (const dir of Object.keys(baseline.packages ?? {})) {
  if (current.packages[dir] === undefined) {
    console.log(`  ${dir}: gone from the workspace, nothing to compare`);
  }
}
console.log(`  ${unchanged} package(s) byte-identical to the baseline.`);

const failed = reportRegressions({
  title: `This tree costs more than ${BASELINE_REL_PATH} allows:`,
  regressions,
  hint:
    "Wall time gates on a calibration-normalized ratio, so a slower machine alone rarely trips it; the calibration line above says how this machine compares. " +
    `If the growth is intended, run \`node scripts/checkPerfBaseline.mjs --update\` on a quiet machine and commit the refreshed ${BASELINE_REL_PATH}, so the increase lands in a pull request diff for a reviewer to agree with.`,
});

if (failed) {
  process.exit(1);
}

console.log(`\n✓ Within the thresholds ${BASELINE_REL_PATH} sets.`);
