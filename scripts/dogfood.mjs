// Dogfood script — run suss's adapter against every `@suss/*` package
// and produce per-package API contracts.
//
// What this does:
//
//   1. Walks `packages/` for every `package.json` whose `name` starts
//      with `@suss/`.
//   2. For each package, builds a `packageExports` pack pointed at the
//      package's `package.json`, then runs the adapter against the
//      package's `tsconfig.json`.
//   3. Writes per-package summaries to `<pkg>/dist/suss-summaries.json`
//      — the format proposed in docs/behavioral-summary-format.md's
//      "Publishing summaries" section, now actual output.
//   4. Writes a consolidated roll-up to `scripts/dogfood-report.json`.
//
// Running this is the fastest way to see what happens when suss
// analyses a real TypeScript codebase — its own. Observations go
// into docs/internal/dogfooding.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTypeScriptAdapter } from "../packages/adapter/typescript/dist/index.js";

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

let totalSummaries = 0;
let totalPackagesWithExports = 0;

for (const pkg of packages) {
  const name = pkg.packageJson.name;
  const tsconfig = path.join(pkg.dir, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) {
    console.log(`\n=== ${name} ===`);
    console.log("  skipped: no tsconfig.json");
    report.packages.push({ name, skipped: "no tsconfig.json" });
    continue;
  }

  console.log(`\n=== ${name} ===`);

  const pack = {
    name: `package-exports:${name}`,
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [
      {
        kind: "library",
        match: {
          type: "packageExports",
          packageJsonPath: pkg.packageJsonPath,
        },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "arg0" },
        { position: 1, role: "arg1" },
        { position: 2, role: "arg2" },
        { position: 3, role: "arg3" },
      ],
    },
  };

  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: tsconfig,
    frameworks: [pack],
  });

  let summaries;
  try {
    summaries = adapter.extractAll();
  } catch (err) {
    console.log(`  error: ${err.message}`);
    report.packages.push({ name, error: err.message });
    continue;
  }

  console.log(`  exports: ${summaries.length}`);
  for (const s of summaries.slice(0, 6)) {
    const exportPath =
      s.identity.boundaryBinding?.semantics?.exportPath?.join(".") ??
      s.identity.name;
    console.log(
      `    - ${exportPath}  (${s.transitions.length} transitions, ${s.inputs.length} inputs, ${s.confidence.level})`,
    );
  }
  if (summaries.length > 6) {
    console.log(`    … +${summaries.length - 6} more`);
  }

  const opaqueCount = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions)
    .filter((c) => c.type === "opaque").length;
  const totalConditions = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions).length;

  if (summaries.length > 0) {
    totalPackagesWithExports += 1;
    totalSummaries += summaries.length;
  }

  // Write per-package summaries file if dist/ exists.
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
    summaryCount: summaries.length,
    opaqueRatio: totalConditions === 0 ? null : opaqueCount / totalConditions,
    summaries: summaries.map((s) => ({
      name: s.identity.name,
      exportPath: s.identity.boundaryBinding?.semantics?.exportPath ?? null,
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

report.totalPackages = packages.length;
report.totalPackagesWithExports = totalPackagesWithExports;
report.totalSummaries = totalSummaries;

const reportPath = path.join(__dirname, "dogfood-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(
  `\nSummary: ${totalSummaries} public exports across ${totalPackagesWithExports}/${packages.length} @suss/* packages.`,
);
console.log(`Report written to ${path.relative(repoRoot, reportPath)}`);
