// profile.mjs: sample `suss extract` over one dogfood target and report
// where the CPU time went.
//
// Run it:
//
//   node scripts/profile.mjs twenty-server           # profile and report
//   node scripts/profile.mjs twenty-front --top 50   # more rows
//   node scripts/profile.mjs --report <file.cpuprofile>
//
// Node's own sampling profiler does the work, so nothing here depends on
// a profiling package. The report has three parts: self time grouped by
// which package the frame belongs to, self time by function, and
// inclusive time by function. Self time says what is burning cycles;
// inclusive time says which phase asked for it.
//
// The benchmark script beside this one answers "did the change help".
// This one answers "what should the next change be".

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CORPUS_TARGETS } from "./corpusTargets.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Same targets and pack choices as the corpus gate, so a profile and
// a gated count describe the same run.
const TARGETS = CORPUS_TARGETS;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    top: { type: "string", default: "30" },
    report: { type: "string" },
    "targets-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const USAGE = `profile.mjs: sample suss extract and report where the time went

  <target>            one of ${Object.keys(TARGETS).join(", ")}
  --report <file>     report an existing .cpuprofile instead of taking one
  --top <n>           rows per table, default 30
  --targets-dir <p>   where the checked-out corpora live
`;

if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function resolveTargetsDir() {
  if (values["targets-dir"] !== undefined) {
    return path.resolve(values["targets-dir"]);
  }
  const local = path.join(repoRoot, "dogfood-targets");
  if (fs.existsSync(local)) {
    return local;
  }
  const commonDir = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repoRoot, encoding: "utf8" },
  ).stdout.trim();
  return path.join(path.dirname(commonDir), "dogfood-targets");
}

// ---------------------------------------------------------------------------
// Taking the profile
// ---------------------------------------------------------------------------

function takeProfile(targetName) {
  const target = TARGETS[targetName];
  if (target === undefined) {
    fail(
      `No target named ${targetName}. Known: ${Object.keys(TARGETS).join(", ")}.`,
    );
  }
  const bin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");
  if (!fs.existsSync(bin)) {
    fail("This checkout has no built CLI. Run `npm run build` first.");
  }
  const tsconfig = path.join(resolveTargetsDir(), target.tsconfig);
  if (!fs.existsSync(tsconfig)) {
    fail(`No tsconfig for ${targetName} at ${tsconfig}.`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-profile-"));
  const summaries = path.join(dir, "summaries.json");
  const res = spawnSync(
    process.execPath,
    [
      "--cpu-prof",
      "--cpu-prof-dir",
      dir,
      bin,
      "extract",
      "-p",
      tsconfig,
      ...target.packs.flatMap((p) => ["-f", p]),
      "--no-cache",
      "-o",
      summaries,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    fail(
      `extract failed on ${targetName}:\n${(res.stderr ?? "").slice(-2000)}`,
    );
  }
  const written = fs.readdirSync(dir).find((n) => n.endsWith(".cpuprofile"));
  if (written === undefined) {
    fail(`No profile landed in ${dir}.`);
  }
  return path.join(dir, written);
}

// ---------------------------------------------------------------------------
// Reading the profile
// ---------------------------------------------------------------------------

// Which package a frame belongs to. The point of the grouping is to
// separate what the compiler does from what suss asks it to do.
const BUCKETS = [
  ["/node_modules/@ts-morph/", "ts-morph (bundled compiler)"],
  ["/node_modules/ts-morph/", "ts-morph (wrappers)"],
  ["/node_modules/typescript/", "typescript"],
  ["/packages/adapter/", "suss adapter"],
  ["/packages/datalog/", "suss datalog"],
  ["/packages/framework/", "suss packs"],
  ["/packages/", "suss other"],
];

function bucketOf(url) {
  for (const [fragment, name] of BUCKETS) {
    if (url.includes(fragment)) {
      return name;
    }
  }
  return url === "" || url.startsWith("node:") ? "node runtime" : "other";
}

function frameName(node) {
  const url = node.callFrame.url
    .replace(/^file:\/\//, "")
    .replace(/^.*\/node_modules\//, "node_modules/")
    .replace(/^.*\/packages\//, "packages/");
  const name = node.callFrame.functionName || "(anonymous)";
  return url === "" ? name : `${name}  ${url}:${node.callFrame.lineNumber + 1}`;
}

function readProfile(file) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parentOf.set(child, node.id);
    }
  }

  // A sample is charged to the frame it landed in for the interval that
  // follows it.
  const selfByNode = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const delta = profile.timeDeltas[i] ?? 0;
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + delta);
    total += delta;
  }

  const selfByBucket = new Map();
  const selfByFrame = new Map();
  const inclusiveByFrame = new Map();
  for (const [id, micros] of selfByNode) {
    const node = byId.get(id);
    if (node === undefined) {
      continue;
    }
    const bucket = bucketOf(node.callFrame.url);
    selfByBucket.set(bucket, (selfByBucket.get(bucket) ?? 0) + micros);
    const name = frameName(node);
    selfByFrame.set(name, (selfByFrame.get(name) ?? 0) + micros);
    // A recursive frame counts once per sample, not once per stack level.
    const onStack = new Set();
    let cursor = id;
    while (cursor !== undefined) {
      const ancestor = byId.get(cursor);
      if (ancestor === undefined) {
        break;
      }
      onStack.add(frameName(ancestor));
      cursor = parentOf.get(cursor);
    }
    for (const ancestor of onStack) {
      inclusiveByFrame.set(
        ancestor,
        (inclusiveByFrame.get(ancestor) ?? 0) + micros,
      );
    }
  }

  return { total, selfByBucket, selfByFrame, inclusiveByFrame };
}

function table(title, counts, total, rows) {
  process.stdout.write(`\n${title}\n`);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, rows);
  for (const [name, micros] of sorted) {
    const ms = `${(micros / 1000).toFixed(0)}ms`.padStart(8);
    const share = `${((micros / total) * 100).toFixed(1)}%`.padStart(7);
    process.stdout.write(`${ms} ${share}  ${name}\n`);
  }
}

const rows = Number(values.top);
if (!Number.isInteger(rows) || rows < 1) {
  fail(`--top takes a whole number of rows. It got "${values.top}".`);
}

const profileFile =
  values.report !== undefined
    ? path.resolve(values.report)
    : takeProfile(positionals[0] ?? fail(USAGE));

const report = readProfile(profileFile);
process.stdout.write(
  `${profileFile}\n${(report.total / 1e6).toFixed(2)}s sampled\n`,
);
table("self time by package", report.selfByBucket, report.total, 20);
table("self time by function", report.selfByFrame, report.total, rows);
table(
  "inclusive time by function",
  report.inclusiveByFrame,
  report.total,
  rows,
);
