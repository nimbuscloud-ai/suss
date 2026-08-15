// checkSelf.mjs: extract suss's own public export surface and run the
// CLI check against the team-authored intent specs in `intent/`.
//
// This is suss dogfooding itself: the two checker packages' public
// exports become `library`-kind provider summaries (via the
// `packageExports` discovery variant), and the boundary intents under
// `intent/` are paired against them by `fn:<package>::<exportPath>` key.
//
// The CLI's `suss extract` has no built-in framework for a package's
// export surface, so extraction is driven here through the adapter with
// a synthesized packageExports pack; the check step is the real CLI
// (`runCli(["check", ...])`). See docs/internal/dogfood-intent-notes.md
// for the friction this surfaced.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Imported from built dist (not bare `@suss/*`) to match scripts/dogfood.mjs
// and stay resolution-stable regardless of the cwd turbo runs this under.
import { createTypeScriptAdapter } from "../packages/adapter/typescript/dist/index.js";
import { runCli } from "../packages/cli/dist/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const intentDir = path.join(repoRoot, "intent");
const summariesDir = path.join(repoRoot, ".self-check", "summaries");
const suppressionsSrc = path.join(intentDir, "self.sussignore.yml");

// Packages whose public export surface has an authored intent spec.
const TARGETS = [
  { dir: "packages/checker", name: "@suss/checker", out: "checker.json" },
  {
    dir: "packages/checker-intent",
    name: "@suss/checker-intent",
    out: "checker-intent.json",
  },
];

/**
 * A pattern pack that treats a package's public export surface as the
 * discovery source: one `library`-kind unit per reachable export, keyed
 * `fn:<package>::<exportPath>`. Terminals mirror the adapter's internal
 * reachable pack (return / throw / implicit fall-through).
 */
function packageExportsPack(name, packageJsonPath) {
  return {
    name: `package-exports:${name}`,
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [
      {
        kind: "library",
        match: { type: "packageExports", packageJsonPath },
        requiresImport: [],
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],
    inputMapping: { type: "allPositional" },
  };
}

async function extractTarget(target) {
  const absDir = path.join(repoRoot, target.dir);
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(absDir, "tsconfig.json"),
    frameworks: [
      packageExportsPack(target.name, path.join(absDir, "package.json")),
    ],
    // The cache keys on the built-in pack set; a synthesized pack isn't
    // versioned, so skip the cache to avoid stale cross-run reuse.
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  // Portable, repo-relative source paths (mirrors `suss extract`).
  for (const s of summaries) {
    s.location.file = path.relative(repoRoot, s.location.file);
  }
  return summaries;
}

async function main() {
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  for (const target of TARGETS) {
    const summaries = await extractTarget(target);
    fs.writeFileSync(
      path.join(summariesDir, target.out),
      `${JSON.stringify(summaries, null, 2)}\n`,
    );
    process.stderr.write(
      `extracted ${summaries.length} summaries from ${target.dir}\n`,
    );
  }

  // A finding neither suppressed nor triaged fails the run. The
  // committed self-check rules under --sussignore are the triage.
  const args = [
    "check",
    "--dir",
    summariesDir,
    "--intent",
    intentDir,
    "--fail-on",
    "warning",
  ];
  if (fs.existsSync(suppressionsSrc)) {
    args.push("--sussignore", suppressionsSrc);
  }
  const code = await runCli(args);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`check:self failed: ${err.stack ?? err}\n`);
  process.exit(1);
});
