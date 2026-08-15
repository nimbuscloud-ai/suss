// Dogfood script: run suss's adapter against every `@suss/*` package
// and produce per-package API contracts.
//
// What this does:
//
//   1. Walks `packages/` for every `package.json` whose `name` starts
//      with `@suss/`.
//   2. For each package, runs the adapter twice:
//      - `packageExports` produces provider (`library`) summaries for
//        the package's public API.
//      - `packageImport` produces consumer (`caller`) summaries for
//        every function that calls into another `@suss/*` package.
//   3. Writes per-package summaries to `<pkg>/.suss/suss-summaries.json`,
//      beside the adapter's extraction cache: a local artifact of a
//      local run, in the directory this repo already keeps out of git
//      and out of every tarball.
//   4. Unions all summaries, runs the checker's `pairSummaries`, and
//      reports paired provider↔consumer edges plus unmatched
//      providers/consumers: the cross-package dependency graph as
//      structured data.
//   5. Writes a consolidated roll-up to `scripts/dogfood-report.json`,
//      and the per-package counts to `scripts/dogfood-baseline.json`.
//      Library summaries are counted on two lines: the ones that sit on
//      the package's declared export surface, and the ones behind it.
//      The roll-up is megabytes and stays out of git; the baseline is
//      committed, and `checkDogfoodBaseline.mjs` compares a fresh run
//      against the copy the author committed.
//   6. Checks the invariants: the things that have to be true of any
//      run, whatever source it ran over.
//
// Exits non-zero if a package failed to extract or an invariant broke.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { evaluatePackHealth } from "../packages/adapter/typescript/dist/index.js";
import { pairSummaries } from "../packages/checker/dist/index.js";
import {
  declaredExports,
  librarySummariesBySurface,
} from "./declaredSurface.mjs";
import { evaluateInvariants } from "./dogfoodInvariants.mjs";
import {
  BASELINE_PATH,
  SUMMARIES_DIR,
  SUMMARIES_FILE,
} from "./dogfoodOutputs.mjs";

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packagesRoot = path.join(repoRoot, "packages");

// ---------------------------------------------------------------------------
// Discover every @suss/* package
// ---------------------------------------------------------------------------

const packageJsonPaths = [];
for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const directChild = path.join(packagesRoot, entry.name, "package.json");
  if (fs.existsSync(directChild)) {
    packageJsonPaths.push(directChild);
    continue;
  }
  // One level deeper (category dirs: framework/, runtime/, stub/, adapter/).
  const nested = path.join(packagesRoot, entry.name);
  for (const child of fs.readdirSync(nested, { withFileTypes: true })) {
    if (!child.isDirectory()) {
      continue;
    }
    const candidate = path.join(nested, child.name, "package.json");
    if (fs.existsSync(candidate)) {
      packageJsonPaths.push(candidate);
    }
  }
}

const packages = packageJsonPaths
  .map((p) => ({
    packageJsonPath: p,
    packageJson: JSON.parse(fs.readFileSync(p, "utf8")),
    dir: path.dirname(p),
  }))
  .filter((p) => typeof p.packageJson.name === "string")
  .filter((p) => p.packageJson.name.startsWith("@suss/"));

packages.sort((a, b) => a.packageJson.name.localeCompare(b.packageJson.name));

// ---------------------------------------------------------------------------
// Run the adapter per-package
// ---------------------------------------------------------------------------

const report = {
  generatedAt: new Date().toISOString(),
  packages: [],
};

let totalExports = 0;
let totalInternal = 0;
let totalConsumers = 0;
let totalPackagesWithExports = 0;
const sussPackageNames = packages.map((p) => p.packageJson.name);
// Also track sub-paths we know about so `@suss/behavioral-ir/schemas`
// consumers pair correctly: the import-site matches the module
// specifier exactly.
const sussImportTargets = new Set(sussPackageNames);
sussImportTargets.add("@suss/behavioral-ir/schemas");

const allSummaries = [];

const workerScript = path.join(__dirname, "dogfood-worker.mjs");
const sussImportTargetsList = [...sussImportTargets];

function runWorker(pkg) {
  return new Promise((resolve) => {
    const worker = new Worker(workerScript, {
      workerData: {
        pkg: {
          packageJson: pkg.packageJson,
          packageJsonPath: pkg.packageJsonPath,
          tsconfig: path.join(pkg.dir, "tsconfig.json"),
        },
        sussImportTargets: sussImportTargetsList,
      },
    });
    let settled = false;
    const finish = (msg) => {
      if (!settled) {
        settled = true;
        resolve(msg);
      }
    };
    worker.once("message", (msg) => {
      finish(msg);
      worker.terminate();
    });
    worker.once("error", (err) => {
      finish({ kind: "error", message: err.message });
    });
    // A worker that dies without a message or an error, which is what a
    // native crash in the thread looks like when the process survives it.
    worker.once("exit", (code) => {
      finish({
        kind: "error",
        message: `worker exited with code ${code} before reporting anything`,
      });
    });
  });
}

async function extractOne(pkg) {
  const name = pkg.packageJson.name;
  const tsconfig = path.join(pkg.dir, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) {
    return { kind: "skipped", name, reason: "no tsconfig.json" };
  }

  // Printed before the work, not with the results: a segfault kills the
  // whole process with nothing said (#249), and then these lines are
  // the only record of which packages were being read.
  process.stdout.write(`  reading ${name}…\n`);
  const result = await runWorker(pkg);
  if (result.kind === "error") {
    return { kind: "error", name, message: result.message };
  }
  return {
    kind: "ok",
    name,
    pkg,
    tsconfig,
    summaries: result.summaries,
    report: result.report,
  };
}

// DOGFOOD_CONCURRENCY pins the worker count. The perf gate sets it so
// peak memory means the same thing on any machine class; unset, the run
// uses every core the machine has. Zero reads as unset.
const concurrency = Math.max(
  2,
  Math.min(
    packages.length,
    Number(process.env.DOGFOOD_CONCURRENCY) || os.cpus().length,
  ),
);
console.log(
  `Extracting ${packages.length} @suss/* packages with concurrency ${concurrency}…`,
);
const extractResults = await mapWithConcurrency(
  packages,
  concurrency,
  extractOne,
);

for (const result of extractResults) {
  console.log(`\n=== ${result.name} ===`);
  if (result.kind === "skipped") {
    console.log(`  skipped: ${result.reason}`);
    report.packages.push({ name: result.name, skipped: result.reason });
    continue;
  }
  if (result.kind === "error") {
    console.log(`  error: ${result.message}`);
    report.packages.push({ name: result.name, error: result.message });
    continue;
  }

  const { name, pkg, tsconfig, summaries } = result;
  const declaredPaths = new Set(
    declaredExports(pkg.packageJson, pkg.dir).map((e) => e.path),
  );
  const { exported, internal } = librarySummariesBySurface(
    summaries,
    declaredPaths,
  );
  const consumers = summaries.filter((s) => s.kind === "caller");

  console.log(
    `  exports: ${exported.length}  |  internal: ${internal.length}  |  consumers: ${consumers.length}`,
  );
  for (const s of exported.slice(0, 4)) {
    const exportPath =
      s.identity.boundaryBinding?.semantics?.exportPath?.join(".") ??
      s.identity.name;
    console.log(
      `    library ${exportPath}  (${s.transitions.length} trans, ${s.inputs.length} in)`,
    );
  }
  if (exported.length > 4) {
    console.log(`    … +${exported.length - 4} more exports`);
  }
  for (const s of consumers.slice(0, 4)) {
    const key =
      s.identity.boundaryBinding?.semantics?.package +
      "::" +
      (s.identity.boundaryBinding?.semantics?.exportPath?.join(".") ?? "?");
    console.log(`    caller  ${s.identity.name} → ${key}`);
  }
  if (consumers.length > 4) {
    console.log(`    … +${consumers.length - 4} more consumers`);
  }

  const opaqueCount = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions)
    .filter((c) => c.type === "opaque").length;
  const totalConditions = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions).length;

  if (exported.length > 0) {
    totalPackagesWithExports += 1;
  }
  totalExports += exported.length;
  totalInternal += internal.length;
  totalConsumers += consumers.length;
  allSummaries.push(...summaries);

  const summariesDir = path.join(pkg.dir, SUMMARIES_DIR);
  const summariesPath = path.join(summariesDir, SUMMARIES_FILE);
  fs.mkdirSync(summariesDir, { recursive: true });
  fs.writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
  console.log(
    `  wrote ${path.relative(repoRoot, summariesPath)} (${summaries.length} summaries)`,
  );

  report.packages.push({
    name,
    dir: path.relative(repoRoot, pkg.dir).split(path.sep).join("/"),
    packageJson: path.relative(repoRoot, pkg.packageJsonPath),
    tsconfig: path.relative(repoRoot, tsconfig),
    exportCount: exported.length,
    internalCount: internal.length,
    consumerCount: consumers.length,
    opaqueRatio: totalConditions === 0 ? null : opaqueCount / totalConditions,
    summaries: summaries.map((s) => ({
      name: s.identity.name,
      exportPath: s.identity.boundaryBinding?.semantics?.exportPath ?? null,
      package: s.identity.boundaryBinding?.semantics?.package ?? null,
      kind: s.kind,
      file: path.relative(repoRoot, s.location.file),
      transitionCount: s.transitions.length,
      inputCount: s.inputs.length,
      confidence: s.confidence.level,
      opaquePredicates: s.transitions
        .flatMap((t) => t.conditions)
        .filter((c) => c.type === "opaque").length,
    })),
  });
}

// ---------------------------------------------------------------------------
// Cross-package pairing
// ---------------------------------------------------------------------------

console.log("\n=== Cross-package pairing ===");
const pairing = pairSummaries(allSummaries);
console.log(`  pairs:               ${pairing.pairs.length}`);
console.log(`  unmatched providers: ${pairing.unmatched.providers.length}`);
console.log(`  unmatched consumers: ${pairing.unmatched.consumers.length}`);
const unpairableByReason = new Map();
for (const entry of pairing.unmatched.unpairable) {
  unpairableByReason.set(
    entry.reason,
    (unpairableByReason.get(entry.reason) ?? 0) + 1,
  );
}
for (const [reason, count] of unpairableByReason) {
  console.log(`  unpairable (${reason}): ${count}`);
}

// Group paired edges by provider package for a readable top-level map.
const edgesByProvider = new Map();
for (const pair of pairing.pairs) {
  const providerPkg =
    pair.provider.identity.boundaryBinding?.semantics?.package ?? "?";
  const providerExport =
    pair.provider.identity.boundaryBinding?.semantics?.exportPath?.join(".") ??
    pair.provider.identity.name;
  const providerKey = `${providerPkg}::${providerExport}`;
  const bucket = edgesByProvider.get(providerKey) ?? [];
  bucket.push({
    consumerFunction: pair.consumer.identity.name,
    consumerFile: path.relative(repoRoot, pair.consumer.location.file),
  });
  edgesByProvider.set(providerKey, bucket);
}

console.log("\n  top consumed exports:");
const ranked = [...edgesByProvider.entries()].sort(
  (a, b) => b[1].length - a[1].length,
);
for (const [key, consumers] of ranked.slice(0, 10)) {
  console.log(`    ${key}  ← ${consumers.length} callers`);
}

report.totalPackages = packages.length;
report.totalPackagesWithExports = totalPackagesWithExports;
report.totalExports = totalExports;
report.totalInternal = totalInternal;
report.totalConsumers = totalConsumers;
report.pairing = {
  pairs: pairing.pairs.length,
  unmatchedProviders: pairing.unmatched.providers.length,
  unmatchedConsumers: pairing.unmatched.consumers.length,
  unpairable: Object.fromEntries(unpairableByReason),
  edgesByProvider: Object.fromEntries(ranked),
};

const reportPath = path.join(__dirname, "dogfood-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// The full report is megabytes of per-summary detail and stays out of
// git. What gets committed is the count of what suss saw, per package,
// so a later run can compare against it and say when suss starts seeing
// less of the same source.
//
// Packages are keyed by directory rather than by name. A rename then
// reads as one package whose count changed, which is what it is, instead
// of one package vanishing and an unrelated one appearing with no
// history to compare against.
//
// Library summaries are counted on two lines because they answer two
// questions and move for different reasons. `exports` counts the
// package's public surface, so it only moves when what callers can reach
// moves. `internal` counts how far the closure got behind that surface,
// so it moves on a refactor as well as on an extraction change. Mixed
// into one number, adding a private helper reads the same as widening
// the API, and most of what the gate would then be guarding is nobody's
// contract.
const baseline = {
  totals: {
    packages: packages.length,
    packagesWithExports: totalPackagesWithExports,
    exports: totalExports,
    internal: totalInternal,
    consumers: totalConsumers,
    pairs: pairing.pairs.length,
  },
  packages: Object.fromEntries(
    report.packages
      .filter((p) => p.skipped === undefined && p.error === undefined)
      .map((p) => [
        p.dir,
        {
          name: p.name,
          exports: p.exportCount,
          internal: p.internalCount,
          consumers: p.consumerCount,
        },
      ]),
  ),
};
fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

console.log(
  `\nSummary: ${totalExports} export + ${totalInternal} internal + ${totalConsumers} consumer summaries across ${packages.length} @suss/* packages. ${pairing.pairs.length} cross-package edges paired.`,
);
console.log(`Report written to ${path.relative(repoRoot, reportPath)}`);
console.log(`Baseline written to ${path.relative(repoRoot, BASELINE_PATH)}`);

const failed = report.packages.filter((p) => p.error !== undefined);
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} package(s) failed to extract:`);
  for (const p of failed) {
    console.error(`  ${p.name}: ${p.error}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
//
// These hold for any source suss runs over, so the run itself is where
// they belong: anyone refreshing the baseline after deleting an export
// finds out here, without needing a git ref to compare against.

// Pack health is the same idea aimed one level down. The invariants
// ask whether the run lost track of something it can see; these ask
// whether any one pack in it stopped working, which a total hides. They
// report and never fail, because a pack that finds nothing is often a
// package that has nothing of that kind in it.

console.log("\n=== Pack health ===");
const unhealthy = extractResults
  .filter((r) => r.kind === "ok" && r.report !== null)
  .flatMap((r) =>
    evaluatePackHealth(r.report)
      .filter((check) => check.violations.length > 0)
      .map((check) => ({ pkg: r.name, check })),
  );

if (unhealthy.length === 0) {
  console.log("  ✓ every pack produced what its own counts say it should");
} else {
  for (const { pkg, check } of unhealthy) {
    for (const violation of check.violations) {
      console.log(`  ${pkg}: ${check.name}: ${violation.detail}`);
    }
  }
}

console.log("\n=== Invariants ===");
const invariants = evaluateInvariants({
  packages: extractResults
    .filter((r) => r.kind === "ok")
    .map((r) => ({
      name: r.name,
      dir: r.pkg.dir,
      packageJson: r.pkg.packageJson,
      summaries: r.summaries,
    })),
  pairing,
});

let brokenInvariants = 0;
for (const invariant of invariants) {
  const mark = invariant.violations.length === 0 ? "✓" : "✗";
  console.log(`  ${mark} ${invariant.name}`);
  for (const violation of invariant.violations) {
    console.error(`      ${violation.label}: ${violation.detail}`);
  }
  brokenInvariants += invariant.violations.length;
}

if (brokenInvariants > 0) {
  console.error(
    `\n✗ ${brokenInvariants} violation(s). Something suss could see before, it cannot see now, on source that says it is still there.`,
  );
  process.exit(1);
}
