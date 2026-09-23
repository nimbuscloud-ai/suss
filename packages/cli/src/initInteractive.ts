/**
 * The guided form of `suss init`.
 *
 * The printed form lists the commands to run. That suits a script, or a
 * user who wants to see what a tool will do before it does it. A person
 * trying suss for the first time would instead have to copy four
 * commands in order.
 *
 * With a terminal attached, init turns the same findings into offers:
 * install the packs, run the first check, add a suppressions file, add a
 * CI step. Nothing is written to disk until the user accepts one. Without
 * a terminal, init prints the commands, which CI jobs that pipe
 * `suss init` rely on.
 */

import fs from "node:fs";
import path from "node:path";

import * as p from "@clack/prompts";

import {
  declaredPacks,
  formatInitReport,
  inspectProject,
  recognizedWithoutPackSentence,
  unnamedLanguageSentence,
  unnamedLanguages,
} from "./init.js";
import { run } from "./processRun.js";
import {
  PROJECT_FILE,
  projectFileFor,
  writeProjectFile,
} from "./projectFile.js";
import { isProjectIn, projectsBelow } from "./projectsBelow.js";
import { DEFAULT_SUPPRESSIONS_FILENAMES } from "./suppressionsLoader.js";
import { readWorkspace } from "./workspaces.js";

import type { InitReport, PackSuggestion } from "./init.js";
import type { Workspace } from "./workspaces.js";

interface Target {
  /** Relative to the directory init ran in, or "." for a single project. */
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
  const targets = await findTargets(root);

  if (options.plain === true || !p.isTTY(process.stdout) || p.isCI()) {
    process.stdout.write(printable(root, targets));
    return 0;
  }

  p.intro("suss init");

  // With no packs to install, the setup still reports what suss could
  // not read, so the user knows why nothing matched.
  const withPacks = targets.filter(
    (target) => declaredPacks(target.report).length > 0,
  );
  if (withPacks.length === 0) {
    p.log.warn(`Nothing in ${root} matched a pack.`);
    p.note(
      "suss reads code through a pack per framework, client, or schema it\nrecognizes, and nothing here names one. `suss --help` lists them.",
      "No packs to suggest",
    );
    reportRecognizedWithoutPack(targets);
    reportUnread(targets);
    reportUnnamedLanguages(targets);
    p.outro("Nothing to set up.");
    return 0;
  }

  reportUnread(targets);

  const chosen = await chooseTargets(withPacks);
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
  await offerProjectFile(root, chosen);

  p.outro("Done. Re-run `suss check --dir summaries/` whenever code changes.");
  return 0;
}

async function findTargets(root: string): Promise<Target[]> {
  const workspace = readWorkspace(root);
  const directories: Array<Pick<Target, "directory" | "label">> =
    workspace.packages.length === 0
      ? [{ directory: ".", label: path.basename(root) }]
      : (workspace.packages as Workspace[]).map((pkg) => ({
          directory: pkg.directory,
          label: pkg.name ?? pkg.directory,
        }));

  // An npm workspace file never lists a Python or Ruby service next to
  // the packages, or a root that is itself a Rails app, so look for those.
  for (const directory of projectDirectoriesAtOrBelow(root)) {
    if (!directories.some((known) => known.directory === directory)) {
      directories.push({ directory, label: directory });
    }
  }

  const targets: Target[] = [];
  for (const { directory, label } of directories) {
    targets.push({
      directory,
      label,
      report: await inspectProject(path.join(root, directory)),
    });
  }

  return withoutLanguagesCoveredBelow(targets).filter((target) =>
    worthReporting(target.report),
  );
}

/** The root and the directories below it that declare a Python or Ruby project of their own. */
function projectDirectoriesAtOrBelow(root: string): string[] {
  const found = new Set<string>();
  for (const language of ["python", "ruby"] as const) {
    if (isProjectIn(root, language)) {
      found.add(".");
    }
    for (const marker of projectsBelow(root, language)) {
      found.add(path.dirname(marker));
    }
  }
  return [...found].sort();
}

/**
 * The root's report counts source files in every project below it. Drop
 * from the root the languages a project below already has packs for, or
 * the root would report them as languages suss could not place.
 */
function withoutLanguagesCoveredBelow(targets: Target[]): Target[] {
  const coveredBelow = new Set(
    targets
      .filter((target) => target.directory !== ".")
      .flatMap((target) => declaredPacks(target.report))
      .map((suggestion) => suggestion.language ?? "typescript"),
  );
  return targets.map((target) =>
    target.directory === "."
      ? {
          ...target,
          report: {
            ...target.report,
            languages: (target.report.languages ?? []).filter(
              (language) => !coveredBelow.has(language),
            ),
          },
        }
      : target,
  );
}

/**
 * Whether a target has anything to report. A Python directory with no
 * requirements file gets no suggestions and has no unread manifest, but
 * the user still needs to hear about it.
 */
const worthReporting = (report: InitReport): boolean =>
  declaredPacks(report).length > 0 ||
  (report.unread ?? []).length > 0 ||
  (report.recognizedWithoutPack ?? []).length > 0 ||
  unnamedLanguages(report).length > 0;

function reportRecognizedWithoutPack(targets: Target[]): void {
  const names = new Set(
    targets.flatMap((target) => target.report.recognizedWithoutPack ?? []),
  );
  for (const name of names) {
    p.log.warn(recognizedWithoutPackSentence(name));
  }
}

function reportUnread(targets: Target[]): void {
  for (const target of targets) {
    for (const entry of target.report.unread ?? []) {
      const where =
        target.directory === "."
          ? entry.where
          : path.join(target.directory, entry.where);
      p.log.warn(`${where}: ${entry.reason}`);
    }
  }
}

function reportUnnamedLanguages(targets: Target[]): void {
  const uncovered = targets.flatMap((target) =>
    unnamedLanguages(target.report),
  );
  if (uncovered.length === 0) {
    return;
  }

  for (const language of new Set(uncovered)) {
    p.log.warn(unnamedLanguageSentence(language));
  }

  p.note(
    "Name one yourself with -f, and `suss --help` lists them all.",
    "Reading it anyway",
  );
}

function printable(root: string, targets: Target[]): string {
  if (targets.length === 0) {
    return formatInitReport({
      root,
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
    `${targets.length} of the projects here have something suss can read.`,
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
  /** Called with each line the command prints, so the spinner can show progress. */
  saw: (line: string) => void;
  stop: (message: string) => void;
}

/**
 * Shows seconds elapsed and the last line the command printed, so the
 * user can tell a long install from a hang.
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

function summarize(line: string): string {
  const withoutPrefix = line.replace(
    /^npm (http|warn|notice|verb|sill)\s+/,
    "",
  );
  // npm's http lines look like "fetch GET 200 <url> 43ms", and the
  // package being fetched is the last path segment.
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
    const missing = (command.needsConfig ?? []).filter(
      (file) => !fs.existsSync(path.join(root, file)),
    );
    if (missing.length > 0) {
      p.log.warn(
        `Skipping \`${command.display}\`: write ${missing.join(", ")} first, then run it. A pack that needs one reads nothing without it.`,
      );
      continue;
    }

    const progress = startProgress(command.display);
    const result = await run(command.bin, command.args, root, progress.saw);
    // `check` exits non-zero when it finds something, so only a crash
    // counts as a failure here.
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
  /** Config files that a pack in this command cannot run without. */
  needsConfig?: string[];
}

function runCommandsFor(target: Target): RunnableCommand[] {
  const commands: RunnableCommand[] = [];
  const prefix = target.directory === "." ? "" : `${target.directory}/`;
  const out = (name: string) => `summaries/${prefix}${name}.json`;

  const code = target.report.suggestions.filter((s) => s.kind !== "contract");
  const languages = [...new Set(code.map((s) => s.language ?? "typescript"))];
  for (const language of languages) {
    // One command per language, because each pack works with one
    // language's adapter.
    const args = ["extract"];
    if (target.directory !== ".") {
      args.push("--dir", target.directory);
    }
    if (language !== "typescript") {
      args.push("--lang", language);
    }
    for (const item of code.filter(
      (s) => (s.language ?? "typescript") === language,
    )) {
      args.push(
        "-f",
        item.configuration === undefined
          ? item.name
          : `${item.name}=${item.configuration.file}`,
      );
    }
    args.push("-o", out(languages.length === 1 ? "code" : language));
    const needsConfig = code
      .filter((s) => (s.language ?? "typescript") === language)
      .filter((s) => s.configuration?.required === true)
      .map((s) => path.join(target.directory, s.configuration?.file ?? ""));
    commands.push({
      bin: "npx",
      args: ["suss", ...args],
      display: `suss ${args.join(" ")}`,
      ...(needsConfig.length > 0 ? { needsConfig } : {}),
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

/**
 * Offers to write the project file, so later commands know which specs
 * and templates this project has. Without it, init is the only place that
 * finds them, and a run that leaves one out pairs those boundaries with
 * nothing and cannot say why.
 */
async function offerProjectFile(root: string, chosen: Target[]): Promise<void> {
  if (fs.existsSync(path.join(root, PROJECT_FILE))) {
    return;
  }

  const entries = chosen.flatMap((target) => {
    const file = projectFileFor(target.report);
    if (file === null) {
      return [];
    }
    return file.read.map((entry) =>
      entry.kind === "contract" && target.directory !== "."
        ? { ...entry, file: path.join(target.directory, entry.file) }
        : entry,
    );
  });
  if (entries.length === 0) {
    return;
  }

  const answer = await p.confirm({
    message: `Write ${PROJECT_FILE}, so later runs know what this project declares?`,
    initialValue: true,
  });
  if (p.isCancel(answer) || !answer) {
    return;
  }

  writeProjectFile(root, { version: 1, read: entries });
  p.log.success(
    `Wrote ${PROJECT_FILE}. Commit it: it says what the project contains, which is the same for everybody.`,
  );
}

async function offerSuppressions(root: string): Promise<void> {
  const file = path.join(root, ".sussignore.json");
  const existing = DEFAULT_SUPPRESSIONS_FILENAMES.some((name) =>
    fs.existsSync(path.join(root, name)),
  );
  if (existing) {
    return;
  }

  const answer = await p.confirm({
    message: "Add a .sussignore for findings you decide to accept?",
    initialValue: false,
  });
  if (p.isCancel(answer) || !answer) {
    return;
  }

  // The schema rejects unknown keys, so the starter explains itself in an
  // example rule's `reason` instead of in a `$comment` key.
  const starter = {
    version: 1,
    rules: [
      {
        kind: "unhandledProviderCase",
        boundary: "GET /example/*",
        effect: "hide",
        reason:
          "replace this example with a decision of your own, and say why you made it",
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
