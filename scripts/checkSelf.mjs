// checkSelf.mjs: check suss's own exports against intent/, through the
// command a user runs, over the summaries `npm run dogfood` wrote. Run
// that first. See intent/README.md for what the documents cover.

import fs from "node:fs";
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

async function main() {
  if (gatherDogfoodSummaries() === 0) {
    process.stderr.write(
      "check:self reads the summaries a dogfood run writes, and there are none. Run `npm run dogfood` first.\n",
    );
    process.exit(1);
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
