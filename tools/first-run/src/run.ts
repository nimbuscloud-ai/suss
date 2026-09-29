/**
 * Runs a published suss CLI the way a newcomer would over each repository
 * in the list, one at a time, and writes what happened under
 * `<work>/results/<name>/`.
 *
 *   npx tsx tools/first-run/src/run.ts --work <dir> --cli <path to suss> [--only a,b]
 *     [--repos <file>] [--skip-install] [--bun <path>] [--yarn <path>]
 *
 * Per repository: a shallow clone at the pin, the install its lockfile
 * asks for, `suss init --write`, every command init printed, `check
 * --dir --json` over what they wrote, and `inspect --diff` between the
 * extract at the pin and the extract at its parent commit. The README
 * says what each recorded field means.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type InitProject,
  type PlannedCommand,
  parseInitOutput,
  planCommands,
} from "./initPlan.js";
import { planInstall } from "./installPlan.js";
import { formatLog, type Measured, runMeasured } from "./measure.js";
import {
  summariseCheck,
  summariseDiff,
  summariseSummaryFile,
} from "./report.js";
import { type RepoEntry, readRepoList } from "./repos.js";

interface Options {
  work: string;
  cli: string;
  repos: string;
  only: Set<string> | undefined;
  skipInstall: boolean;
  bun: string;
  yarn: string;
  budgetMinutes: number;
}

const COMMAND_TIMEOUT_SECONDS = 900;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const entries = readRepoList(options.repos).filter(
    (entry) => options.only === undefined || options.only.has(entry.name),
  );
  for (const entry of entries) {
    process.stderr.write(`\n== ${entry.name} (${entry.stack}) ==\n`);
    const result = runRepo(entry, options);
    process.stderr.write(`${entry.name}: ${result.outcome}\n`);
  }
}

interface StepRecord {
  step: string;
  project?: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  peakRssBytes: number | null;
  log: string;
}

interface RepoResult {
  name: string;
  stack: string;
  commit: string;
  installed: boolean;
  outcome: string;
  steps: StepRecord[];
  initNotes: string[];
  configsWritten: string[];
  summaries: ReturnType<typeof summariseSummaryFile>[];
  check: ReturnType<typeof summariseCheck> | null;
  diff: ReturnType<typeof summariseDiff> | null;
  packHealth: string[];
  errors: string[];
  cloneMs: number;
  wallMs: number;
  peakRssBytes: number | null;
}

class Budget {
  private deadline: number;

  constructor(private readonly minutes: number) {
    this.deadline = Date.now() + minutes * 60_000;
  }

  /** The clone depends on the network rather than on suss, so the budget starts after it. */
  restart(): void {
    this.deadline = Date.now() + this.minutes * 60_000;
  }

  secondsLeft(): number {
    return Math.min(
      COMMAND_TIMEOUT_SECONDS,
      (this.deadline - Date.now()) / 1000,
    );
  }

  spent(): boolean {
    return this.secondsLeft() < 5;
  }
}

function runRepo(entry: RepoEntry, options: Options): RepoResult {
  const started = Date.now();
  const cloneDir = path.join(options.work, "repos", entry.name);
  const resultsDir = path.join(options.work, "results", entry.name);
  fs.rmSync(resultsDir, { recursive: true, force: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  const budget = new Budget(options.budgetMinutes);
  const result: RepoResult = {
    name: entry.name,
    stack: entry.stack,
    commit: entry.commit,
    installed: false,
    outcome: "ok",
    steps: [],
    initNotes: [],
    configsWritten: [],
    summaries: [],
    check: null,
    diff: null,
    packHealth: [],
    errors: [],
    cloneMs: 0,
    wallMs: 0,
    peakRssBytes: null,
  };
  const record = (
    step: string,
    measured: Measured,
    project?: string,
  ): Measured => {
    const log = path.join(
      resultsDir,
      `${String(result.steps.length).padStart(2, "0")}-${step}.log`,
    );
    fs.writeFileSync(log, formatLog(measured));
    result.steps.push({
      step,
      ...(project === undefined ? {} : { project }),
      argv: measured.argv,
      exitCode: measured.exitCode,
      timedOut: measured.timedOut,
      wallMs: measured.wallMs,
      peakRssBytes: measured.peakRssBytes,
      log: path.basename(log),
    });
    if (measured.timedOut) {
      result.errors.push(
        `${step} timed out after ${Math.round(measured.wallMs / 1000)}s`,
      );
    }

    return measured;
  };

  try {
    runStages(entry, options, { cloneDir, resultsDir, budget, result, record });
  } catch (error) {
    result.outcome = "error";
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  result.wallMs = Date.now() - started;
  result.peakRssBytes = peakOf(
    result.steps.filter((step) => step.step !== "install"),
  );
  fs.writeFileSync(
    path.join(resultsDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

interface StageContext {
  cloneDir: string;
  resultsDir: string;
  budget: Budget;
  result: RepoResult;
  record: (step: string, measured: Measured, project?: string) => Measured;
}

function runStages(
  entry: RepoEntry,
  options: Options,
  context: StageContext,
): void {
  const { cloneDir, resultsDir, budget, result, record } = context;
  const cloneStarted = Date.now();
  cloneAtPin(entry, cloneDir);
  result.cloneMs = Date.now() - cloneStarted;
  budget.restart();
  installDependencies(options, context);
  if (budget.spent()) {
    result.outcome = "budget";
    return;
  }

  const init = record(
    "init",
    runMeasured([options.cli, "init", "--write"], {
      cwd: cloneDir,
      timeoutSeconds: budget.secondsLeft(),
    }),
  );
  if (init.exitCode !== 0) {
    result.outcome = "initFailed";
    return;
  }

  const projects = parseInitOutput(init.stdout);
  result.initNotes = projects.flatMap((project) =>
    project.notes.map((note) => `${project.dir}: ${note}`),
  );
  result.configsWritten = writeSuggestedConfigs(projects, cloneDir);
  const headDir = path.join(cloneDir, ".suss-first-run", "head");
  fs.rmSync(path.dirname(headDir), { recursive: true, force: true });
  fs.mkdirSync(headDir, { recursive: true });
  const planned = planCommands(projects, cloneDir, headDir);
  fs.writeFileSync(
    path.join(resultsDir, "plan.json"),
    `${JSON.stringify(planned, null, 2)}\n`,
  );
  for (const command of planned) {
    if (budget.spent()) {
      result.outcome = "budget";
      return;
    }

    const measured = record(
      command.verb,
      runMeasured([options.cli, ...command.argv], {
        cwd: command.cwd,
        timeoutSeconds: budget.secondsLeft(),
      }),
      command.project,
    );
    result.packHealth.push(
      ...packHealthLines(measured.stderr, command.project),
    );
    if (fs.existsSync(command.output)) {
      result.summaries.push(
        summariseSummaryFile(command.output, command.project, command.verb),
      );
    }
  }

  runCheck(options, context, headDir);
  runDiff(entry, options, context, planned);
}

/**
 * init leaves a pack that needs a value it cannot work out off suss.json,
 * but still prints it in the extract command, and prints an example
 * config. A newcomer following the instructions writes that example.
 */
function writeSuggestedConfigs(
  projects: InitProject[],
  cloneDir: string,
): string[] {
  const written: string[] = [];
  for (const project of projects) {
    for (const config of project.configs) {
      const file = path.resolve(cloneDir, project.dir, config.file);
      if (fs.existsSync(file)) {
        continue;
      }

      fs.writeFileSync(file, `${config.contents}\n`);
      written.push(`${path.relative(cloneDir, file)}: ${config.contents}`);
    }
  }

  return written;
}

function runCheck(
  options: Options,
  context: StageContext,
  headDir: string,
): void {
  const { resultsDir, budget, result, record } = context;
  if (fs.readdirSync(headDir).length === 0) {
    result.outcome = "nothingExtracted";
    return;
  }

  const jsonPath = path.join(resultsDir, "check.json");
  record(
    "check-json",
    runMeasured(
      [options.cli, "check", "--dir", headDir, "--json", "-o", jsonPath],
      {
        cwd: context.cloneDir,
        timeoutSeconds: budget.secondsLeft(),
      },
    ),
  );
  const text = record(
    "check-text",
    runMeasured([options.cli, "check", "--dir", headDir], {
      cwd: context.cloneDir,
      timeoutSeconds: budget.secondsLeft(),
    }),
  );
  const printed = text.stdout + text.stderr;
  fs.writeFileSync(path.join(resultsDir, "check.txt"), printed);
  if (fs.existsSync(jsonPath)) {
    result.check = summariseCheck(
      JSON.parse(fs.readFileSync(jsonPath, "utf8")),
      printed,
    );
  }
}

/**
 * The PR comment extracts the base commit with the same packs and diffs
 * the two, so this re-runs only the extract commands at the parent and
 * compares them with the extracts at the pin.
 */
function runDiff(
  entry: RepoEntry,
  options: Options,
  context: StageContext,
  planned: PlannedCommand[],
): void {
  const { cloneDir, resultsDir, budget, result, record } = context;
  const extracts = planned.filter(
    (command) => command.verb === "extract" && fs.existsSync(command.output),
  );
  if (extracts.length === 0 || budget.spent()) {
    return;
  }

  const root = path.join(cloneDir, ".suss-first-run");
  const afterDir = path.join(root, "after");
  const beforeDir = path.join(root, "before");
  fs.mkdirSync(afterDir, { recursive: true });
  fs.mkdirSync(beforeDir, { recursive: true });
  for (const command of extracts) {
    fs.copyFileSync(
      command.output,
      path.join(afterDir, path.basename(command.output)),
    );
  }

  git(cloneDir, ["checkout", "--quiet", "--detach", "HEAD~1"]);
  try {
    for (const command of extracts) {
      if (budget.spent()) {
        result.errors.push("budget ran out during the parent extract");
        return;
      }

      const beforeOutput = path.join(beforeDir, path.basename(command.output));
      const argv = command.argv.map((arg) =>
        arg === command.output ? beforeOutput : arg,
      );
      record(
        "extract-parent",
        runMeasured([options.cli, ...argv], {
          cwd: command.cwd,
          timeoutSeconds: budget.secondsLeft(),
        }),
        command.project,
      );
    }
  } finally {
    git(cloneDir, ["checkout", "--quiet", "--detach", entry.commit]);
  }

  const diffJson = record(
    "diff-json",
    runMeasured(
      [options.cli, "inspect", "--diff", beforeDir, afterDir, "--json"],
      {
        cwd: cloneDir,
        timeoutSeconds: budget.secondsLeft(),
      },
    ),
  );
  const diffText = record(
    "diff-text",
    runMeasured([options.cli, "inspect", "--diff", beforeDir, afterDir], {
      cwd: cloneDir,
      timeoutSeconds: budget.secondsLeft(),
    }),
  );
  fs.writeFileSync(path.join(resultsDir, "diff.json"), diffJson.stdout);
  fs.writeFileSync(
    path.join(resultsDir, "diff.txt"),
    diffText.stdout + diffText.stderr,
  );
  result.diff = summariseDiff(diffJson.stdout);
}

function installDependencies(options: Options, context: StageContext): void {
  if (options.skipInstall) {
    return;
  }

  const steps = planInstall(context.cloneDir, {
    bun: options.bun,
    yarn: options.yarn,
  });
  let allPassed = steps.length > 0;
  for (const step of steps) {
    const measured = context.record(
      "install",
      runMeasured(step.argv, {
        cwd: step.dir,
        timeoutSeconds: context.budget.secondsLeft(),
        env: step.env,
      }),
      path.relative(context.cloneDir, step.dir) || ".",
    );
    allPassed = allPassed && measured.exitCode === 0;
  }

  context.result.installed = allPassed;
}

function cloneAtPin(entry: RepoEntry, cloneDir: string): void {
  if (fs.existsSync(cloneDir) && headOf(cloneDir) === entry.commit) {
    // Clearing what an earlier run wrote keeps this run a first run; the install stays.
    git(cloneDir, ["clean", "-fdxq", "-e", "node_modules"]);
    return;
  }

  try {
    freshShallowClone(entry, cloneDir);
  } catch {
    // A large shallow fetch now and then comes back short of objects; one retry covers it.
    freshShallowClone(entry, cloneDir);
  }
}

function freshShallowClone(entry: RepoEntry, cloneDir: string): void {
  fs.rmSync(cloneDir, { recursive: true, force: true });
  fs.mkdirSync(cloneDir, { recursive: true });
  git(cloneDir, ["init", "--quiet"]);
  git(cloneDir, ["remote", "add", "origin", entry.url]);
  git(cloneDir, ["fetch", "--quiet", "--depth", "2", "origin", entry.commit]);
  git(cloneDir, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
}

function headOf(dir: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`,
    );
  }
}

const PACK_HEALTH =
  /pack health|recogni[sz]ed none|recogni[sz]ed no|read no files|matched nothing/i;

function packHealthLines(stderr: string, project: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => PACK_HEALTH.test(line))
    .map((line) => `${project}: ${line.trim()}`);
}

function peakOf(steps: StepRecord[]): number | null {
  const peaks = steps
    .map((step) => step.peakRssBytes)
    .filter((peak) => peak !== null);
  return peaks.length === 0 ? null : Math.max(...peaks);
}

function parseArgs(args: string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const work = value("--work");
  const cli = value("--cli");
  if (work === undefined || cli === undefined) {
    throw new Error(
      "usage: run.ts --work <dir> --cli <path to suss> [--only a,b] [--skip-install]",
    );
  }

  const only = value("--only");
  return {
    work: path.resolve(work),
    cli: path.resolve(cli),
    repos: path.resolve(
      value("--repos") ?? path.join(HERE, "..", "repos.json"),
    ),
    only: only === undefined ? undefined : new Set(only.split(",")),
    skipInstall: args.includes("--skip-install"),
    bun: value("--bun") ?? "bun",
    yarn: value("--yarn") ?? "yarn",
    budgetMinutes: Number(value("--budget-minutes") ?? "30"),
  };
}

main();
