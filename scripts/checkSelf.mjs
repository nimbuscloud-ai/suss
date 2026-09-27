// checkSelf.mjs: check suss's own exports against intent/, through the
// command a user runs, over the summaries `npm run dogfood` wrote. Run
// that first. See intent/README.md for what the documents cover.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Imported from built dist (not bare `@suss/*`) to match scripts/dogfood.mjs
// and stay resolution-stable regardless of the cwd turbo runs this under.
import { runCli } from "../packages/cli/dist/index.js";
import { SUMMARIES_DIR, SUMMARIES_FILE } from "./dogfoodOutputs.mjs";
import { ROOT, readWorkspacePackages } from "./workspacePackages.mjs";

const intentDir = path.join(ROOT, "intent");
const summariesDir = path.join(ROOT, ".self-check", "summaries");
const suppressionsSrc = path.join(intentDir, "self.sussignore.yml");

/**
 * Copies each package's dogfood summaries into one folder, because
 * `suss check --dir` reads only the files directly inside the folder it
 * is given. Returns how many packages had summaries to copy.
 */
function gatherDogfoodSummaries() {
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  let copied = 0;
  for (const pkg of readWorkspacePackages()) {
    const written = path.join(ROOT, pkg.dir, SUMMARIES_DIR, SUMMARIES_FILE);
    if (!fs.existsSync(written)) {
      continue;
    }
    const target = `${pkg.dir.split("/").join("-")}.json`;
    fs.copyFileSync(written, path.join(summariesDir, target));
    copied += 1;
  }
  return copied;
}

/** The covering test the canary renames, and the file that lists it. */
const CANARY = {
  file: "checkAnAgentsEdit.prd.yaml",
  title: "splits the findings into new and gone, by identity",
};

function checkArgs(intent, extra = []) {
  // A finding neither suppressed nor triaged fails the run. The
  // committed self-check rules under --sussignore are the triage.
  const args = [
    "check",
    "--dir",
    summariesDir,
    "--intent",
    intent,
    "--fail-on",
    "warning",
    ...extra,
  ];
  if (fs.existsSync(suppressionsSrc)) {
    args.push("--sussignore", suppressionsSrc);
  }
  return args;
}

/**
 * The same check over a copy of intent/ with one covering test renamed,
 * which has to fail and say the test is missing. Without it, a check
 * that stopped reading coveredBy would pass every run.
 */
async function renamedTestFails() {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "suss-self-canary-"));
  try {
    fs.cpSync(intentDir, copy, { recursive: true });
    const prd = path.join(copy, CANARY.file);
    const written = fs.readFileSync(prd, "utf8");
    if (!written.includes(CANARY.title)) {
      return `${CANARY.file} no longer lists the test "${CANARY.title}", which the canary renames. Point CANARY at another covering test.`;
    }
    fs.writeFileSync(
      prd,
      written.replace(CANARY.title, `${CANARY.title}, renamed`),
    );

    const report = path.join(copy, "report.json");
    const code = await runCli(checkArgs(copy, ["--json", "-o", report]));
    const kinds = (
      JSON.parse(fs.readFileSync(report, "utf8")).intent?.findings ?? []
    )
      .filter((finding) => finding.suppressed === undefined)
      .map((finding) => finding.kind);
    if (code === 0 || !kinds.includes("missingCoveringTest")) {
      return `renaming the covering test "${CANARY.title}" should fail the check with missingCoveringTest, and it gave exit ${code} with ${kinds.join(", ") || "no findings"}.`;
    }
    return null;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

async function main() {
  if (gatherDogfoodSummaries() === 0) {
    process.stderr.write(
      "check:self reads the summaries a dogfood run writes, and there are none. Run `npm run dogfood` first.\n",
    );
    process.exit(1);
  }

  const code = await runCli(checkArgs(intentDir));
  if (code !== 0) {
    process.exit(code);
  }
  const canary = await renamedTestFails();
  if (canary !== null) {
    process.stderr.write(`check:self canary: ${canary}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`check:self failed: ${err.stack ?? err}\n`);
  process.exit(1);
});
