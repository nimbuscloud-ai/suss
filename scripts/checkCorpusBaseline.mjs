// checkCorpusBaseline.mjs - extract the pinned public corpora and
// compare the counts against scripts/corpus-baseline.json. A drop is
// a regression; a rise is recorded on purpose with --update.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CORPUS_REPOS, CORPUS_TARGETS } from "./corpusTargets.mjs";
import { initPlan } from "./initPlan.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baselinePath = path.join(repoRoot, "scripts", "corpus-baseline.json");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    update: { type: "boolean", default: false },
    target: { type: "string", multiple: true },
    "targets-dir": { type: "string" },
  },
});

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

function readBaseline() {
  if (!fs.existsSync(baselinePath)) {
    return { targets: {} };
  }
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

/**
 * What one target comes to, by running what `suss init` printed for it.
 *
 * The commands, the pack names in them and the config files they read
 * all come out of init, so this measures the path somebody takes rather
 * than a pack list written here. A command that fails is the finding:
 * init sent somebody to it.
 */
function measure(targetName, targetsDir) {
  const target = CORPUS_TARGETS[targetName];
  const bin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");
  if (!fs.existsSync(bin)) {
    fail("This checkout has no built CLI. Run `npm run build` first.");
  }
  const project = path.join(targetsDir, target.directory);
  if (!fs.existsSync(project)) {
    return null;
  }

  const plan = initPlan(bin, project);
  for (const [name, contents] of Object.entries(plan.configs)) {
    fs.writeFileSync(path.join(project, name), `${contents}\n`);
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "suss-corpus-"));
  let summaries = [];
  for (const command of plan.commands) {
    const written = runPlanned(command, targetName, project, bin, out);
    summaries = [...summaries, ...written];
  }

  fs.rmSync(out, { recursive: true, force: true });
  return {
    pin: CORPUS_REPOS[target.repo].pin,
    commands: plan.commands.length,
    summaries: summaries.length,
    boundaries: summaries.filter((s) => s.identity?.boundaryBinding != null)
      .length,
  };
}

/** One command from the plan, run where a person would run it. */
function runPlanned(command, targetName, project, bin, out) {
  // `check` reads what the others wrote and reports rather than
  // producing summaries, and its exit code says how the corpus checks
  // out rather than whether the command worked.
  const isCheck = command.startsWith("suss check");
  const args = command
    .split(" ")
    .slice(1)
    .map((argument) =>
      argument.startsWith("summaries/") ? path.join(out, argument) : argument,
    );

  // Only extract reads a cache, and a corpus run measures a cold read.
  const cold = command.startsWith("suss extract") ? ["--no-cache"] : [];
  const run = spawnSync(process.execPath, [bin, ...args, ...cold], {
    cwd: project,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!isCheck && run.status !== 0) {
    fail(
      `${targetName}: \`${command}\`, which suss init printed, failed:\n${(run.stderr ?? "").slice(-2000)}`,
    );
  }

  const written = args[args.indexOf("-o") + 1];
  if (written === undefined || !fs.existsSync(written)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(written, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.summaries ?? []);
}

const targetsDir = resolveTargetsDir();
const wanted =
  values.target !== undefined && values.target.length > 0
    ? values.target
    : Object.keys(CORPUS_TARGETS);
for (const name of wanted) {
  if (CORPUS_TARGETS[name] === undefined) {
    fail(
      `No target named ${name}. Known: ${Object.keys(CORPUS_TARGETS).join(", ")}.`,
    );
  }
}

const baseline = readBaseline();
const problems = [];
const next = { targets: { ...baseline.targets } };

for (const name of wanted) {
  const measured = measure(name, targetsDir);
  if (measured === null) {
    // A machine without this corpus checked out cannot say anything
    // about it, which is different from the corpus extracting to less.
    process.stdout.write(`- ${name}: not checked out here, skipped\n`);
    continue;
  }

  const recorded = baseline.targets?.[name];
  process.stdout.write(
    `- ${name}: ${measured.summaries} summaries, ${measured.boundaries} with boundaries\n`,
  );
  next.targets[name] = measured;

  if (values.update || recorded === undefined) {
    continue;
  }
  if (recorded.pin !== measured.pin) {
    problems.push(
      `${name}: the baseline was recorded at pin ${recorded.pin.slice(0, 12)} and the registry now pins ${measured.pin.slice(0, 12)}. Re-record with --update.`,
    );
    continue;
  }
  for (const field of ["summaries", "boundaries"]) {
    if (measured[field] !== recorded[field]) {
      problems.push(
        `${name}: ${field} moved from ${recorded[field]} to ${measured[field]} on pinned code. A drop is a regression; a rise gets recorded with --update.`,
      );
    }
  }
}

if (values.update) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`Baseline written to ${baselinePath}.\n`);
  process.exit(0);
}

const unrecorded = wanted.filter(
  (name) =>
    baseline.targets?.[name] === undefined && next.targets[name] !== undefined,
);
if (unrecorded.length > 0) {
  process.stdout.write(
    `Unrecorded targets measured, run with --update to record: ${unrecorded.join(", ")}\n`,
  );
}

if (problems.length > 0) {
  fail(problems.join("\n"));
}
process.stdout.write("Corpus counts match the baseline.\n");
