// benchmark.mjs: time `suss extract` over the public dogfood targets.
//
// Run it:
//
//   node scripts/benchmark.mjs                     # this build, 3 repeats
//   node scripts/benchmark.mjs --subset            # the three quick targets
//   node scripts/benchmark.mjs --against 6a8a1b0   # this build vs a commit
//   node scripts/benchmark.mjs --json out.json     # also write the raw runs
//
// Every run passes `--no-cache` and `--datalog-profile`, and every
// number records the commit it came from. When two builds are compared
// the script alternates between them within each repeat, because a run
// order that puts one build in the machine's quiet half hands it the
// win. It refuses to print anything on a loaded machine.
//
// The five targets take about five minutes at three repeats. `--subset`
// takes about a minute and a half and leaves out twenty-server, where
// the import gate is most of the run, and twenty-front, the largest
// corpus here.
//
// `--against` builds the other commit in a worktree under the temp
// directory and keeps it, so the next comparison against the same commit
// starts measuring straight away. That build caches its tasks inside its
// own worktree, so nothing it produces can be restored into the tree the
// author works in. `git worktree list` shows them and `git worktree
// remove` takes one back out.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Pack choices match the ones the recorded corpus measurements used, so a
// number produced here is comparable with the ones already published.
const TARGETS = [
  {
    name: "twenty-server",
    tsconfig: "twenty/packages/twenty-server/tsconfig.json",
    packs: ["nestjs-rest", "nestjs-graphql", "node"],
  },
  {
    name: "twenty-front",
    tsconfig: "twenty/packages/twenty-front/tsconfig.json",
    packs: ["react", "apollo-client", "fetch"],
  },
  {
    name: "saleor-dashboard",
    tsconfig: "saleor-dashboard/tsconfig.json",
    packs: ["react", "apollo-client", "fetch"],
  },
  {
    name: "saleor-storefront",
    tsconfig: "saleor-storefront/tsconfig.json",
    packs: ["react", "nextjs", "fetch"],
  },
  {
    name: "directus-api",
    tsconfig: "directus/api/tsconfig.json",
    packs: ["express", "fetch"],
  },
];

// The quick set keeps one corpus where the datalog rules dominate, which
// is where engine work shows up at all.
const SUBSET = ["saleor-dashboard", "saleor-storefront", "directus-api"];

// Above half the cores busy, wall clock stops describing the build. One
// measurement swung by a factor of two under load.
const MAX_LOAD_PER_CORE = 0.5;

// A machine that speeds up or slows down mid-run invalidates the
// comparison, however quiet it looked at the start.
const MAX_CALIBRATION_DRIFT = 0.25;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    against: { type: "string" },
    targets: { type: "string" },
    subset: { type: "boolean" },
    pairs: { type: "string", default: "3" },
    json: { type: "string" },
    "targets-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const USAGE = `benchmark.mjs: time suss extract over the public dogfood targets

  --against <ref>     compare this build against another commit, interleaved
  --subset            run ${SUBSET.join(", ")}
  --targets <a,b>     run named targets (${TARGETS.map((t) => t.name).join(", ")})
  --pairs <n>         repeats per build, default 3, minimum 3 when comparing
  --targets-dir <p>   where the checked-out corpora live
  --json <path>       write every run to a file alongside the report
`;

if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function selectedTargets() {
  if (values.targets !== undefined) {
    const wanted = values.targets.split(",").map((s) => s.trim());
    const unknown = wanted.filter((w) => !TARGETS.some((t) => t.name === w));
    if (unknown.length > 0) {
      fail(
        `No target named ${unknown.join(", ")}. Known: ${TARGETS.map((t) => t.name).join(", ")}.`,
      );
    }
    return TARGETS.filter((t) => wanted.includes(t.name));
  }
  if (values.subset === true) {
    return TARGETS.filter((t) => SUBSET.includes(t.name));
  }
  return TARGETS;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Machine state
// ---------------------------------------------------------------------------

function loadPerCore() {
  return os.loadavg()[0] / os.cpus().length;
}

function refuseIfLoaded() {
  const load = loadPerCore();
  if (load > MAX_LOAD_PER_CORE) {
    fail(
      `Load average is ${os.loadavg()[0].toFixed(1)} across ${os.cpus().length} cores, ` +
        `${(load * 100).toFixed(0)}% busy per core. Timings taken now would be unusable, ` +
        `so this run stops here. Retry under ${(MAX_LOAD_PER_CORE * 100).toFixed(0)}%.`,
    );
  }
  return load;
}

// One core's arithmetic throughput, which drops when every core is taken.
function calibrationMs() {
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

function bestCalibration(samples = 3) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    best = Math.min(best, calibrationMs());
  }
  return best;
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function git(args, cwd = repoRoot) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

function binFor(dir) {
  return path.join(dir, "packages", "cli", "dist", "bin.js");
}

function describeBuild(dir, label) {
  const sha = git(["rev-parse", "--short", "HEAD"], dir);
  const dirty = git(["status", "--porcelain"], dir) !== "";
  return { label, dir, sha, dirty };
}

function thisBuild() {
  if (!fs.existsSync(binFor(repoRoot))) {
    fail("This checkout has no built CLI. Run `npm run build` first.");
  }
  return describeBuild(repoRoot, "this build");
}

// A second build lives in its own worktree under the temp directory, so a
// comparison never disturbs the tree the author is working in.
function buildAt(ref) {
  const sha = git(["rev-parse", "--short", ref]);
  const dir = path.join(os.tmpdir(), "suss-benchmark-builds", sha);
  if (!fs.existsSync(binFor(dir))) {
    if (!fs.existsSync(dir)) {
      process.stderr.write(
        `Preparing a build at ${sha}. This takes a few minutes.\n`,
      );
      git(["worktree", "add", "--detach", dir, sha]);
    }
    runOrFail(dir, "npm", ["install", "--no-audit", "--no-fund"]);
    // The build cache is keyed by what a task reads, not by which tree
    // ran it, so a shared cache lets this build's artifacts be restored
    // into the tree the author works in, and the other way around. Once
    // that happens every later run replays it. This build caches inside
    // its own worktree, where only it can reach.
    runOrFail(dir, "npm", ["run", "build"], {
      TURBO_CACHE_DIR: turboCacheDirFor(dir),
    });
  }
  return describeBuild(dir, sha);
}

/** Where a comparison build keeps its own task cache. */
function turboCacheDirFor(dir) {
  return path.join(dir, ".turbo", "benchmark-cache");
}

function runOrFail(cwd, command, args, env = {}) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    fail(`${command} ${args.join(" ")} failed in ${cwd}.`);
  }
}

// ---------------------------------------------------------------------------
// One measured run
// ---------------------------------------------------------------------------

const DATALOG_LINE = /^datalog: (\d+)ms \(\s*([\d.]+)% of (\d+)ms wall\)/m;

function extractOnce(build, target, targetsDir) {
  const tsconfig = path.join(targetsDir, target.tsconfig);
  const output = path.join(os.tmpdir(), `suss-benchmark-${process.pid}.json`);
  const args = [
    binFor(build.dir),
    "extract",
    "-p",
    tsconfig,
    ...target.packs.flatMap((p) => ["-f", p]),
    "--no-cache",
    "--datalog-profile",
    "-o",
    output,
  ];

  const started = performance.now();
  const res = spawnSync(process.execPath, args, {
    cwd: build.dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  fs.rmSync(output, { force: true });

  if (res.status !== 0) {
    fail(
      `extract failed on ${target.name} at ${build.sha} (exit ${res.status}):\n${(res.stderr ?? "").slice(-2000)}`,
    );
  }

  const profile = DATALOG_LINE.exec(res.stderr ?? "");
  const summaries = /Wrote (\d+) summar/.exec(res.stderr ?? "");
  return {
    wallMs,
    datalogMs: profile === null ? null : Number(profile[1]),
    datalogShare: profile === null ? null : Number(profile[2]),
    summaries: summaries === null ? null : Number(summaries[1]),
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarise(runs) {
  const walls = runs.map((r) => r.wallMs);
  const med = median(walls);
  const datalogs = runs.map((r) => r.datalogMs).filter((d) => d !== null);
  const shares = runs.map((r) => r.datalogShare).filter((s) => s !== null);
  return {
    runs: runs.length,
    medianMs: med,
    minMs: Math.min(...walls),
    maxMs: Math.max(...walls),
    spread: (Math.max(...walls) - Math.min(...walls)) / med,
    datalogMs: datalogs.length > 0 ? median(datalogs) : null,
    datalogShare: shares.length > 0 ? median(shares) : null,
    summaries: runs[0].summaries,
  };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function percent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

// The profile reports a share already in percent.
function share(alreadyPercent) {
  return alreadyPercent === null ? "?" : `${alreadyPercent.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function resolveTargetsDir() {
  if (values["targets-dir"] !== undefined) {
    return path.resolve(values["targets-dir"]);
  }
  const local = path.join(repoRoot, "dogfood-targets");
  if (fs.existsSync(local)) {
    return local;
  }
  // A worktree does not contain the corpora, which are untracked beside the
  // main checkout.
  const commonDir = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return path.join(path.dirname(commonDir), "dogfood-targets");
}

const targets = selectedTargets();
const targetsDir = resolveTargetsDir();
for (const target of targets) {
  const tsconfig = path.join(targetsDir, target.tsconfig);
  if (!fs.existsSync(tsconfig)) {
    fail(
      `No tsconfig for ${target.name} at ${tsconfig}. Check the corpora out under ${targetsDir}, ` +
        "or point --targets-dir at them.",
    );
  }
}

const comparing = values.against !== undefined;
const requestedPairs = Number(values.pairs);
if (!Number.isInteger(requestedPairs) || requestedPairs < 1) {
  fail(`--pairs takes a whole number of repeats. It got "${values.pairs}".`);
}
if (comparing && requestedPairs < 3) {
  fail("A comparison takes at least three pairs, so a median means something.");
}

const startLoad = refuseIfLoaded();
const builds = comparing
  ? [thisBuild(), buildAt(values.against)]
  : [thisBuild()];

const dirtyBuilds = builds.filter((b) => b.dirty);
if (dirtyBuilds.length > 0) {
  process.stderr.write(
    `Note: ${dirtyBuilds.map((b) => b.sha).join(", ")} has uncommitted changes, ` +
      "so the commit recorded below does not fully describe what ran.\n",
  );
}

process.stderr.write(
  `Timing ${targets.length} target${targets.length === 1 ? "" : "s"} over ` +
    `${requestedPairs} repeat${requestedPairs === 1 ? "" : "s"} of ` +
    `${builds.map((b) => `${b.label} (${b.sha})`).join(" against ")}.\n`,
);

const calibrations = [bestCalibration()];
const results = new Map();
for (const target of targets) {
  for (const build of builds) {
    results.set(`${target.name} ${build.sha}`, []);
  }
}

for (let repeat = 1; repeat <= requestedPairs; repeat++) {
  for (const target of targets) {
    // Alternating within the repeat rather than running one build to
    // completion keeps a cold file cache or a busy stretch from landing on
    // one side of the comparison.
    for (const build of builds) {
      // Checking before every run stops a benchmark that has already been
      // spoiled from spending another ten minutes proving it.
      refuseIfLoaded();
      calibrations.push(bestCalibration(1));
      const run = extractOnce(build, target, targetsDir);
      results.get(`${target.name} ${build.sha}`).push(run);
      process.stderr.write(
        `  ${String(repeat).padStart(2)}  ${target.name.padEnd(18)} ${build.sha.padEnd(10)} ` +
          `${seconds(run.wallMs).padStart(8)}  datalog ${run.datalogMs ?? "?"}ms\n`,
      );
    }
  }
}

calibrations.push(bestCalibration());
const calibrationMedian = median(calibrations);
const calibrationDrift =
  (Math.max(...calibrations) - Math.min(...calibrations)) / calibrationMedian;
const endLoad = loadPerCore();

if (calibrationDrift > MAX_CALIBRATION_DRIFT) {
  fail(
    "The machine changed speed during the run: the calibration loop varied by " +
      `${percent(calibrationDrift)} (${calibrations.map((c) => c.toFixed(0)).join(", ")}ms). ` +
      "These timings are unusable and are not being reported. Retry on a quiet machine.",
  );
}
if (endLoad > MAX_LOAD_PER_CORE) {
  fail(
    `Load average rose to ${percent(endLoad)} per core while the benchmark ran. ` +
      "These timings are unusable and are not being reported.",
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const lines = [];
lines.push("");
lines.push(
  `Machine: ${os.cpus().length} cores, load ${percent(startLoad)} to ${percent(endLoad)} per core, ` +
    `calibration drift ${percent(calibrationDrift)}.`,
);
lines.push(
  `Builds: ${builds.map((b) => `${b.label} = ${b.sha}${b.dirty ? " (dirty)" : ""}`).join(", ")}. ` +
    `${requestedPairs} repeats, --no-cache throughout, medians below.`,
);
lines.push("");

const summaries = new Map();
for (const target of targets) {
  for (const build of builds) {
    const key = `${target.name} ${build.sha}`;
    summaries.set(key, summarise(results.get(key)));
  }
}

if (comparing) {
  const [after, before] = builds;
  lines.push(
    `| corpus | ${before.sha} | ${after.sha} | change | spread ${before.sha} | spread ${after.sha} | datalog ${before.sha} | datalog ${after.sha} |`,
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const target of targets) {
    const b = summaries.get(`${target.name} ${before.sha}`);
    const a = summaries.get(`${target.name} ${after.sha}`);
    const change = (a.medianMs - b.medianMs) / b.medianMs;
    const decided =
      Math.abs(change) > Math.max(b.spread, a.spread) ? "" : " (inside spread)";
    lines.push(
      `| ${target.name} | ${seconds(b.medianMs)} | ${seconds(a.medianMs)} | ` +
        `${change >= 0 ? "+" : ""}${percent(change)}${decided} | ${percent(b.spread)} | ${percent(a.spread)} | ` +
        `${b.datalogMs}ms (${share(b.datalogShare)}) | ${a.datalogMs}ms (${share(a.datalogShare)}) |`,
    );
  }
} else {
  lines.push(
    "| corpus | packs | median | min | max | spread | datalog | share | summaries |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const target of targets) {
    const s = summaries.get(`${target.name} ${builds[0].sha}`);
    lines.push(
      `| ${target.name} | ${target.packs.join(", ")} | ${seconds(s.medianMs)} | ${seconds(s.minMs)} | ` +
        `${seconds(s.maxMs)} | ${percent(s.spread)} | ${s.datalogMs}ms | ${share(s.datalogShare)} | ${s.summaries} |`,
    );
  }
}

lines.push("");
lines.push(
  "Spread is (max - min) / median across the repeats. A difference smaller " +
    "than the spread is not a difference this harness can see.",
);
lines.push("");
process.stdout.write(`${lines.join("\n")}\n`);

if (values.json !== undefined) {
  const payload = {
    measuredAt: new Date().toISOString(),
    machine: {
      cores: os.cpus().length,
      startLoadPerCore: startLoad,
      endLoadPerCore: endLoad,
      calibrationMs: calibrations,
    },
    builds,
    repeats: requestedPairs,
    targets: targets.map((target) => ({
      name: target.name,
      packs: target.packs,
      builds: builds.map((build) => ({
        sha: build.sha,
        ...summaries.get(`${target.name} ${build.sha}`),
        runs: results.get(`${target.name} ${build.sha}`),
      })),
    })),
  };
  fs.writeFileSync(
    path.resolve(values.json),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stderr.write(`Wrote every run to ${path.resolve(values.json)}\n`);
}
