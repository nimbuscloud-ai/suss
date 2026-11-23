/**
 * checkPerf.mjs: what suss costs at HEAD against another commit, both
 * built and measured on this machine in this run, taking turns. The other
 * commit defaults to the last release before HEAD. It compares the fixture
 * extracts (both builds read this checkout's fixtures), the dogfood run
 * (each build over its own source) and the packed tarball sizes, and fails
 * past the limits below. CONTRIBUTING.md says more.
 *
 *   node scripts/checkPerf.mjs                  against the last release
 *   node scripts/checkPerf.mjs --base v0.38.0   against any commit
 *   node scripts/checkPerf.mjs --repeats 3      more repeats
 *
 * A run rewrites the dogfood baselines in both checkouts, as dogfood does.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { reportRegressions } from "./baselineCompare.mjs";
import { binFor, buildAt, git, heapFlags } from "./comparisonBuild.mjs";
import { findManifests, ROOT } from "./workspacePackages.mjs";

const RSS_RATIO_LIMIT = 1.25;
const WALL_RATIO_LIMIT = 1.5;
const SIZE_GROWTH_FRACTION = 0.15;
const SIZE_GROWTH_FLOOR_BYTES = 250 * 1024;
const RSS_SAMPLE_MS = 100;

// Dogfood normally takes a worker per core, which makes its peak RSS a
// function of the machine. Four is the CI runner's core count.
const DOGFOOD_WORKERS = 4;

// A fixed list, so a new fixture changes what is measured only when
// someone adds it here. Prisma, drizzle, the contract packs and the
// Python fixtures give `suss extract` no TypeScript target of their own.
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
  // The aws-lambda pack finds these fixtures' handlers in their SAM
  // templates; the producer packs alone see no unit bodies.
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
    base: { type: "string" },
    repeats: { type: "string", default: "2" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help === true) {
  process.stdout.write(
    `checkPerf.mjs: compare what suss costs at HEAD with what it cost at another commit

  --base <ref>   the commit to compare against, default the last release before HEAD
  --repeats <n>  repeats per build, default 2; wall takes the min, RSS the max
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
// The two builds
// ---------------------------------------------------------------------------

/** The newest release tag that HEAD itself is not, so a release commit compares with the release before it. */
function lastReleaseBeforeHead() {
  return git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD^"]);
}

function headBuild() {
  if (!fs.existsSync(binFor(ROOT))) {
    fail("This checkout has no built CLI. Run `npm run build` first.");
  }
  return {
    label: "head",
    sha: git(["rev-parse", "--short", "HEAD"]),
    dir: ROOT,
  };
}

function baseBuild(ref) {
  const built = buildAt(ref);
  return { label: "base", sha: built.sha, dir: built.dir };
}

// ---------------------------------------------------------------------------
// One measured child process
// ---------------------------------------------------------------------------

// VmHWM is the process's own high-water mark, so on Linux one late sample
// is enough. Elsewhere ps reads the current RSS every 100ms. Worker threads
// share their parent's address space, so one pid covers the dogfood run.
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

/** Runs a command, sampling its memory, and resolves with its wall time, peak RSS, exit code and the end of its output. */
function runMeasured(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
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
      resolve({
        wallMs: performance.now() - started,
        peakRssBytes,
        code,
        tail: Buffer.concat(output).toString("utf8").slice(-2000),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

function fixtureArgs(build, target, outFile) {
  const input =
    target.tsconfig === undefined
      ? ["--dir", path.join(ROOT, target.dir)]
      : ["-p", path.join(ROOT, target.tsconfig)];
  return [
    binFor(build.dir),
    "extract",
    ...input,
    ...target.packs.flatMap((pack) => ["-f", pack]),
    "--no-cache",
    "-o",
    outFile,
  ];
}

/**
 * Each fixture target once under one build, keyed by target name. A run
 * the build could not finish keeps its exit code and output. The heap
 * flags keep the CLI from starting itself again, so the process sampled
 * is the one doing the work.
 */
async function runFixturesOnce(build, nodeFlags) {
  const outFile = path.join(
    os.tmpdir(),
    `suss-perf-${process.pid}-${build.label}.json`,
  );
  const runs = new Map();
  try {
    for (const target of FIXTURE_TARGETS) {
      const args = [...nodeFlags, ...fixtureArgs(build, target, outFile)];
      runs.set(target.name, await runMeasured(process.execPath, args, ROOT));
    }
  } finally {
    fs.rmSync(outFile, { force: true });
  }
  return runs;
}

async function runDogfoodOnce(build) {
  const run = await runMeasured(
    process.execPath,
    [path.join(build.dir, "scripts", "dogfood.mjs")],
    build.dir,
    { DOGFOOD_CONCURRENCY: String(DOGFOOD_WORKERS) },
  );
  if (run.code !== 0) {
    fail(`dogfood at ${build.sha} exited ${run.code}:\n${run.tail}`);
  }
  return run;
}

/** The fixture targets every run of both builds finished, so the two sums cover the same work. */
function targetsBothRan(fixtureRuns) {
  return FIXTURE_TARGETS.map((target) => target.name).filter((name) =>
    fixtureRuns.every((byTarget) => byTarget.get(name)?.code === 0),
  );
}

/** Each repeat's wall time summed, and peak RSS taken, over the targets both builds ran. */
function fixtureTotals(fixtureRuns, targets) {
  return fixtureRuns.map((byTarget) => {
    const runs = targets.map((name) => byTarget.get(name));
    return {
      wallMs: runs.reduce((sum, run) => sum + run.wallMs, 0),
      peakRssBytes: Math.max(0, ...runs.map((run) => run.peakRssBytes)),
    };
  });
}

// Min wall and max RSS: noise only ever adds time, and the peak that
// matters is the largest any run reached.
function summarise(runs) {
  return {
    wallMs: Math.round(Math.min(...runs.map((r) => r.wallMs))),
    peakRssBytes: Math.max(...runs.map((r) => r.peakRssBytes)),
  };
}

/** Packed bytes for every workspace package in a checkout, keyed by package name. */
function packageSizes(root) {
  const dirs = findManifests(path.join(root, "packages")).map((manifest) =>
    path.relative(root, path.dirname(manifest)),
  );
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", ...dirs.map((dir) => `--workspace=${dir}`)],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return new Map(JSON.parse(out).map((entry) => [entry.name, entry.size]));
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

for (const target of FIXTURE_TARGETS) {
  const entry = path.join(ROOT, target.tsconfig ?? target.dir);
  if (!fs.existsSync(entry)) {
    fail(`Fixture target ${target.name} points at ${entry}, which is gone.`);
  }
}

const head = headBuild();
const baseRef = values.base ?? lastReleaseBeforeHead();
const base = baseBuild(baseRef);
const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores`;

process.stderr.write(
  `Comparing HEAD (${head.sha}) with ${baseRef} (${base.sha}) on ${machine}, ` +
    `${repeats} repeat(s) each, taking turns.\n`,
);

const nodeFlags = await heapFlags();
const fixtureRuns = { base: [], head: [] };
const dogfoodRuns = { base: [], head: [] };
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const build of [base, head]) {
    fixtureRuns[build.label].push(await runFixturesOnce(build, nodeFlags));
    const dogfood = await runDogfoodOnce(build);
    dogfoodRuns[build.label].push(dogfood);
    process.stderr.write(
      `  ${repeat} ${build.label.padEnd(4)}  dogfood ${seconds(dogfood.wallMs)}, peak ${formatBytes(dogfood.peakRssBytes)}\n`,
    );
  }
}

const everyFixtureRun = [...fixtureRuns.base, ...fixtureRuns.head];
const compared = targetsBothRan(everyFixtureRun);
const workloads = {
  fixtures: {
    base: summarise(fixtureTotals(fixtureRuns.base, compared)),
    head: summarise(fixtureTotals(fixtureRuns.head, compared)),
  },
  dogfood: {
    base: summarise(dogfoodRuns.base),
    head: summarise(dogfoodRuns.head),
  },
};

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const regressions = [];

console.log(
  `\nHEAD (${head.sha}) against ${baseRef} (${base.sha}), both measured on ${machine}:`,
);

const skipped = FIXTURE_TARGETS.map((target) => target.name).filter(
  (name) => !compared.includes(name),
);
for (const name of skipped) {
  const failed = everyFixtureRun
    .map((byTarget) => byTarget.get(name))
    .find((run) => run.code !== 0);
  console.log(
    `  fixture ${name} left out of both sums, because a build could not extract it: ` +
      failed.tail.trim().split("\n").at(-1),
  );
}

for (const [name, { base: was, head: now }] of Object.entries(workloads)) {
  const wallRatio = now.wallMs / was.wallMs;
  const rssRatio = now.peakRssBytes / was.peakRssBytes;
  console.log(
    `  ${name} wall: ${seconds(was.wallMs)} → ${seconds(now.wallMs)}, ` +
      `${wallRatio.toFixed(2)}x (fails past ${WALL_RATIO_LIMIT.toFixed(2)}x)`,
  );
  console.log(
    `  ${name} peak RSS: ${formatBytes(was.peakRssBytes)} → ${formatBytes(now.peakRssBytes)}, ` +
      `${rssRatio.toFixed(2)}x (fails past ${RSS_RATIO_LIMIT.toFixed(2)}x)`,
  );
  if (wallRatio > WALL_RATIO_LIMIT) {
    regressions.push({
      label: `${name} wall time`,
      detail: `${seconds(was.wallMs)} → ${seconds(now.wallMs)}, ${wallRatio.toFixed(2)}x, limit ${WALL_RATIO_LIMIT}x`,
    });
  }
  if (rssRatio > RSS_RATIO_LIMIT) {
    regressions.push({
      label: `${name} peak RSS`,
      detail: `${formatBytes(was.peakRssBytes)} → ${formatBytes(now.peakRssBytes)}, ${rssRatio.toFixed(2)}x, limit ${RSS_RATIO_LIMIT}x`,
    });
  }
}
console.log(
  "  Each dogfood run reads its own commit's source, so part of a change there is suss's own code growing.",
);

console.log("\nPacked tarball sizes:");
const baseSizes = packageSizes(base.dir);
const headSizes = packageSizes(head.dir);
let unchanged = 0;
for (const [name, now] of headSizes) {
  const was = baseSizes.get(name);
  if (was === undefined) {
    console.log(`  ${name}: new since ${baseRef}, ${formatBytes(now)}`);
    continue;
  }
  // A version bump alone moves every tarball by a few bytes.
  if (Math.abs(now - was) < 1024) {
    unchanged += 1;
    continue;
  }
  console.log(`  ${name}: ${formatBytes(was)} → ${formatBytes(now)}`);
  const allowedGrowth = Math.max(
    was * SIZE_GROWTH_FRACTION,
    SIZE_GROWTH_FLOOR_BYTES,
  );
  if (now > was + allowedGrowth) {
    regressions.push({
      label: name,
      detail: `packed ${formatBytes(was)} → ${formatBytes(now)}, past the allowed growth of ${formatBytes(allowedGrowth)}`,
    });
  }
}
for (const name of baseSizes.keys()) {
  if (!headSizes.has(name)) {
    console.log(`  ${name}: gone since ${baseRef}`);
  }
}
console.log(
  `  ${unchanged} package(s) within 1kB of their size at ${baseRef}.`,
);

const failed = reportRegressions({
  title: `HEAD costs more than ${baseRef} by more than the limits allow:`,
  regressions,
  hint: "Both builds ran on this machine, taking turns, so these ratios compare like with like.",
});

if (failed) {
  process.exit(1);
}

console.log(`\n✓ Within the limits against ${baseRef}.`);
