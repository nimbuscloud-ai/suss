// Dogfood script — run suss's adapter against every `@suss/*` package
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
//   3. Writes per-package summaries to `<pkg>/dist/suss-summaries.json`.
//   4. Unions all summaries, runs the checker's `pairSummaries`, and
//      reports paired provider↔consumer edges plus unmatched
//      providers/consumers — the cross-package dependency graph as
//      structured data.
//   5. Writes a consolidated roll-up to `scripts/dogfood-report.json`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { pairSummaries } from "../packages/checker/dist/index.js";

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

let totalProviders = 0;
let totalConsumers = 0;
let totalPackagesWithExports = 0;
const sussPackageNames = packages.map((p) => p.packageJson.name);
// Also track sub-paths we know about so `@suss/behavioral-ir/schemas`
// consumers pair correctly — the import-site matches the module
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
    worker.once("message", (msg) => {
      resolve(msg);
      worker.terminate();
    });
    worker.once("error", (err) => {
      resolve({ kind: "error", message: err.message });
    });
  });
}

async function extractOne(pkg) {
  const name = pkg.packageJson.name;
  const tsconfig = path.join(pkg.dir, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) {
    return { kind: "skipped", name, reason: "no tsconfig.json" };
  }

  const result = await runWorker(pkg);
  if (result.kind === "error") {
    return { kind: "error", name, message: result.message };
  }
  return { kind: "ok", name, pkg, tsconfig, summaries: result.summaries };
}

const concurrency = Math.max(2, Math.min(packages.length, os.cpus().length));
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
  const providers = summaries.filter((s) => s.kind === "library");
  const consumers = summaries.filter((s) => s.kind === "caller");

  console.log(
    `  providers: ${providers.length}  |  consumers: ${consumers.length}`,
  );
  for (const s of providers.slice(0, 4)) {
    const exportPath =
      s.identity.boundaryBinding?.semantics?.exportPath?.join(".") ??
      s.identity.name;
    console.log(
      `    library ${exportPath}  (${s.transitions.length} trans, ${s.inputs.length} in)`,
    );
  }
  if (providers.length > 4) {
    console.log(`    … +${providers.length - 4} more providers`);
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

  if (providers.length > 0) {
    totalPackagesWithExports += 1;
  }
  totalProviders += providers.length;
  totalConsumers += consumers.length;
  allSummaries.push(...summaries);

  const distDir = path.join(pkg.dir, "dist");
  const summariesPath = path.join(distDir, "suss-summaries.json");
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
    console.log(
      `  wrote ${path.relative(repoRoot, summariesPath)} (${summaries.length} summaries)`,
    );
  } else {
    console.log("  skipped summary file: dist/ not present (run build first)");
  }

  report.packages.push({
    name,
    packageJson: path.relative(repoRoot, pkg.packageJsonPath),
    tsconfig: path.relative(repoRoot, tsconfig),
    providerCount: providers.length,
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
console.log(`  noBinding:           ${pairing.unmatched.noBinding.length}`);

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
report.totalProviders = totalProviders;
report.totalConsumers = totalConsumers;
report.pairing = {
  pairs: pairing.pairs.length,
  unmatchedProviders: pairing.unmatched.providers.length,
  unmatchedConsumers: pairing.unmatched.consumers.length,
  noBinding: pairing.unmatched.noBinding.length,
  edgesByProvider: Object.fromEntries(ranked),
};

const reportPath = path.join(__dirname, "dogfood-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(
  `\nSummary: ${totalProviders} provider + ${totalConsumers} consumer summaries across ${packages.length} @suss/* packages. ${pairing.pairs.length} cross-package edges paired.`,
);
console.log(`Report written to ${path.relative(repoRoot, reportPath)}`);
