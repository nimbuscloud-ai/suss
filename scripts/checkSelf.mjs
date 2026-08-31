// checkSelf.mjs: run suss on suss, through the commands a user runs.
// Every step goes through `runCli`, so a change that breaks the shipped
// CLI breaks this too. See intent/README.md for what the documents cover.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Imported from built dist (not bare `@suss/*`) to match scripts/dogfood.mjs
// and stay resolution-stable regardless of the cwd turbo runs this under.
import { runCli } from "../packages/cli/dist/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const intentDir = path.join(repoRoot, "intent");
const summariesDir = path.join(repoRoot, ".self-check", "summaries");
const suppressionsSrc = path.join(intentDir, "self.sussignore.yml");

// Packages whose public export surface has an authored intent document.
const TARGETS = [
  { dir: "packages/checker", out: "checker.json" },
  { dir: "packages/checker-intent", out: "checker-intent.json" },
];

async function extractTarget(target) {
  const code = await runCli([
    "extract",
    "-f",
    "package-exports",
    "-p",
    path.join(repoRoot, target.dir, "tsconfig.json"),
    "-o",
    path.join(summariesDir, target.out),
  ]);
  if (code !== 0) {
    throw new Error(`extract failed for ${target.dir}`);
  }
}

async function main() {
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  for (const target of TARGETS) {
    await extractTarget(target);
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
