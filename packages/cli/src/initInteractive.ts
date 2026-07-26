// initInteractive.ts — the guided setup.
//
// `suss init` on its own reads the project and prints the commands. That
// is the right output for a script, a CI file, or anyone who would
// rather see what a tool intends before it acts. It is a poor first run
// for a person, who now has to copy four commands in order.
//
// So when a terminal is attached, the same findings become a set of
// offers: install these packs, run the first check, keep a suppressions
// file, add a CI step. Every one is declined by pressing enter on "no",
// and nothing touches the disk until it is accepted.
//
// Without a terminal, or under --yes-less automation, this falls
// straight through to the printed form. A CI job piping `suss init` must
// keep working.

import fs from "node:fs";
import path from "node:path";

import * as p from "@clack/prompts";

import { formatInitReport, inspectProject } from "./init.js";
import { run } from "./processRun.js";
import { readWorkspace } from "./workspaces.js";

import type { InitReport, PackSuggestion } from "./init.js";
import type { Workspace } from "./workspaces.js";

/** One package in the run, with what suss found in it. */
interface Target {
  /** Relative to where init was pointed. "." for a single project. */
  directory: string;
  label: string;
  report: InitReport;
}

export interface InteractiveInitOptions {
  dir?: string;
  /** Force the printed form even with a terminal attached. */
  plain?: boolean;
}

export async function initInteractive(
  options: InteractiveInitOptions = {},
): Promise<number> {
  const root = path.resolve(options.dir ?? process.cwd());
  const targets = findTargets(root);

  // No terminal means no prompts. A pipe, a CI job, or `--plain` all get
  // the printed commands, which are the same instructions the questions
  // below would carry out.
  if (options.plain === true || !p.isTTY(process.stdout) || p.isCI()) {
    process.stdout.write(printable(targets));
    return 0;
  }

  p.intro("suss init");

  if (targets.length === 0) {
    p.log.warn(`Nothing in ${root} matched a pack.`);
    p.note(
      "suss reads code through a pack per framework, client, or schema it\nrecognizes, and nothing here names one. `suss --help` lists them.",
      "No packs to suggest",
    );
    p.outro("Nothing to set up.");
    return 0;
  }

  const chosen = await chooseTargets(targets);
  if (chosen === null) {
    p.cancel("Left everything as it was.");
    return 0;
  }

  showFindings(chosen);

  const packs = uniquePacks(chosen);
  const installed = await offerInstall(root, packs);
  if (installed === "cancelled") {
    p.cancel("Left everything as it was.");
    return 0;
  }

  await offerFirstRun(root, chosen, installed === "installed");
  await offerSuppressions(root);
  await offerCi(root, chosen);

  p.outro("Done. Re-run `suss check --dir summaries/` whenever code changes.");
  return 0;
}

/** Every package worth setting up, whether this is one project or many. */
function findTargets(root: string): Target[] {
  const workspace = readWorkspace(root);

  if (workspace.packages.length === 0) {
    const report = inspectProject(root);
    return report.suggestions.length > 0
      ? [{ directory: ".", label: path.basename(root), report }]
      : [];
  }

  return workspace.packages
    .map((pkg: Workspace) => ({
      directory: pkg.directory,
      label: pkg.name ?? pkg.directory,
      report: inspectProject(path.join(root, pkg.directory)),
    }))
    .filter((target) => target.report.suggestions.length > 0);
}

function printable(targets: Target[]): string {
  if (targets.length === 0) {
    return formatInitReport({
      root: process.cwd(),
      tsconfig: null,
      suggestions: [],
    });
  }
  if (targets.length === 1 && targets[0]?.directory === ".") {
    return formatInitReport(targets[0].report);
  }
  return targets
    .map(
      (t) =>
        `${"═".repeat(4)} ${t.directory} ${"═".repeat(4)}\n\n${formatInitReport(t.report)}`,
    )
    .join("\n");
}

async function chooseTargets(targets: Target[]): Promise<Target[] | null> {
  if (targets.length === 1) {
    return targets;
  }

  p.log.info(
    `This is a workspace. ${targets.length} of its packages have something suss can read.`,
  );

  const selected = await p.multiselect({
    message: "Which should suss set up?",
    options: targets.map((t) => ({
      value: t.directory,
      label: t.label,
      hint: t.report.suggestions.map((s) => s.name).join(", "),
    })),
    initialValues: targets.map((t) => t.directory),
    required: false,
  });

  if (p.isCancel(selected)) {
    return null;
  }
  const picked = targets.filter((t) => selected.includes(t.directory));
  return picked.length === 0 ? null : picked;
}

function showFindings(targets: Target[]): void {
  for (const target of targets) {
    const lines = target.report.suggestions
      .map((s) => `${s.name.padEnd(16)} ${s.because}`)
      .join("\n");
    p.note(lines, target.directory === "." ? "Found" : target.directory);
  }
}

function uniquePacks(targets: Target[]): PackSuggestion[] {
  const byPackage = new Map<string, PackSuggestion>();
  for (const target of targets) {
    for (const suggestion of target.report.suggestions) {
      byPackage.set(suggestion.packageName, suggestion);
    }
  }
  return [...byPackage.values()];
}

interface Progress {
  /** Hand each line the command prints, to show where it has got to. */
  saw: (line: string) => void;
  stop: (message: string) => void;
}

/**
 * A spinner that answers "is this stuck?".
 *
 * Installing five packs pulls their dependency trees too, which can run
 * to the better part of a minute on a cold cache. A bare spinner gives
 * no way to tell that from a hang, so this shows the seconds elapsed and
 * the last thing the command said.
 */
function startProgress(label: string): Progress {
  const spin = p.spinner();
  spin.start(label);

  const started = Date.now();
  let latest = "";

  const redraw = (): void => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const elapsed = seconds < 1 ? label : `${label} (${seconds}s)`;
    spin.message(latest === "" ? elapsed : `${elapsed}  ${latest}`);
  };

  const tick = setInterval(redraw, 1000);
  // Nothing should be held open on this timer if the process is otherwise
  // ready to exit.
  tick.unref?.();

  return {
    saw: (line) => {
      latest = summarize(line);
      redraw();
    },
    stop: (message) => {
      clearInterval(tick);
      spin.stop(message);
    },
  };
}

/** The part of a line worth putting next to a spinner. */
function summarize(line: string): string {
  const withoutPrefix = line.replace(
    /^npm (http|warn|notice|verb|sill)\s+/,
    "",
  );
  // npm's http lines read "fetch GET 200 <url> 43ms". The package being
  // fetched is the useful part, and it is the last path segment.
  const fetched = withoutPrefix.match(/https?:\/\/\S*?\/([^/\s]+)\/-\//);
  const text = fetched?.[1] ?? withoutPrefix;
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

type InstallOutcome = "installed" | "skipped" | "cancelled";

async function offerInstall(
  root: string,
  packs: PackSuggestion[],
): Promise<InstallOutcome> {
  const packages = ["@suss/cli", ...packs.map((s) => s.packageName)];

  const answer = await p.confirm({
    message: `Install ${packages.length} packages as devDependencies?`,
    initialValue: true,
  });
  if (p.isCancel(answer)) {
    return "cancelled";
  }
  if (!answer) {
    p.log.info(
      `Skipped. Run this when you want them:\n  npm install --save-dev ${packages.join(" ")}`,
    );
    return "skipped";
  }

  const progress = startProgress(`Installing ${packages.length} packages`);
  const result = await run(
    "npm",
    ["install", "--save-dev", "--loglevel", "http", ...packages],
    root,
    progress.saw,
  );
  if (result.code === 0) {
    progress.stop(`Installed ${packages.length} packages`);
    return "installed";
  }

  progress.stop("Install failed");
  // A half-done install is worse than none, so say what broke and leave
  // the command behind rather than carrying on as though it worked.
  p.log.error(lastLines(result.output, 6));
  p.log.info(
    `Nothing else was changed. To retry:\n  npm install --save-dev ${packages.join(" ")}`,
  );
  return "skipped";
}

async function offerFirstRun(
  root: string,
  targets: Target[],
  installed: boolean,
): Promise<void> {
  const commands = targets.flatMap((t) => runCommandsFor(t));
  if (commands.length === 0) {
    return;
  }

  if (!installed) {
    p.log.info(
      `Once the packs are installed:\n${commands.map((c) => `  ${c.display}`).join("\n")}`,
    );
    return;
  }

  const answer = await p.confirm({
    message: "Read the code now and compare what it finds?",
    initialValue: true,
  });
  if (p.isCancel(answer) || !answer) {
    p.log.info(
      `When you are ready:\n${commands.map((c) => `  ${c.display}`).join("\n")}`,
    );
    return;
  }

  for (const command of commands) {
    const progress = startProgress(command.display);
    const result = await run(command.bin, command.args, root, progress.saw);
    // `check` exits non-zero when it finds something, which is the tool
    // working, so only a crash counts as a failure here.
    if (result.code === 0 || command.findingsAreExpected) {
      progress.stop(command.display);
    } else {
      progress.stop(`${command.display} failed`);
      p.log.error(lastLines(result.output, 8));
      return;
    }
    if (command.showOutput) {
      p.log.message(lastLines(result.output, 20));
    }
  }
}

interface RunnableCommand {
  bin: string;
  args: string[];
  display: string;
  showOutput?: boolean;
  findingsAreExpected?: boolean;
}

function runCommandsFor(target: Target): RunnableCommand[] {
  const commands: RunnableCommand[] = [];
  const prefix = target.directory === "." ? "" : `${target.directory}/`;
  const out = (name: string) => `summaries/${prefix}${name}.json`;

  const code = target.report.suggestions.filter((s) => s.kind !== "contract");
  if (code.length > 0) {
    const args = ["extract"];
    if (target.directory !== ".") {
      args.push("--dir", target.directory);
    }
    for (const item of code) {
      args.push("-f", item.name);
    }
    args.push("-o", out("code"));
    commands.push({
      bin: "npx",
      args: ["suss", ...args],
      display: `suss ${args.join(" ")}`,
    });
  }

  for (const item of target.report.suggestions.filter(
    (s) => s.kind === "contract",
  )) {
    if (item.file === undefined) {
      continue;
    }
    const args = [
      "contract",
      "--from",
      item.name,
      path.join(target.directory === "." ? "" : target.directory, item.file),
      "-o",
      out(item.name),
    ];
    commands.push({
      bin: "npx",
      args: ["suss", ...args],
      display: `suss ${args.join(" ")}`,
    });
  }

  return commands;
}

async function offerSuppressions(root: string): Promise<void> {
  const file = path.join(root, ".sussignore.json");
  if (fs.existsSync(file)) {
    return;
  }

  const answer = await p.confirm({
    message: "Add a .sussignore for findings you decide to accept?",
    initialValue: false,
  });
  if (p.isCancel(answer) || !answer) {
    return;
  }

  const starter = {
    $comment:
      "A rule silences one finding. Give every rule a reason, so the next person knows it was a decision.",
    rules: [
      {
        kind: "unhandledProviderCase",
        boundary: "GET /example/*",
        effect: "hide",
        reason: "replace this example with a decision of your own",
      },
    ],
  };
  fs.writeFileSync(file, `${JSON.stringify(starter, null, 2)}\n`);
  p.log.success("Wrote .sussignore.json with one example rule");
}

async function offerCi(root: string, targets: Target[]): Promise<void> {
  const file = path.join(root, ".github", "workflows", "suss.yml");
  if (fs.existsSync(file)) {
    return;
  }

  const answer = await p.confirm({
    message:
      "Add a GitHub Actions workflow that runs this on every pull request?",
    initialValue: false,
  });
  if (p.isCancel(answer) || !answer) {
    return;
  }

  const steps = targets
    .flatMap((t) => runCommandsFor(t))
    .map((c) => `          npx ${c.display}`)
    .join("\n");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `name: suss

on: pull_request

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci

      - name: Read both sides of every boundary
        run: |
${steps}

      # check exits non-zero when it finds anything at error severity,
      # so this step is the gate. Add --fail-on warning to gate harder.
      - name: Compare them
        run: npx suss check --dir summaries/
`,
  );
  p.log.success("Wrote .github/workflows/suss.yml");
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
