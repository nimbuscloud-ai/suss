/**
 * The guided form of `suss init`.
 *
 * The printed form lists the commands to run, which suits a script or a
 * user who wants to see what a tool will do first. A person trying suss
 * for the first time would instead have to copy four commands in order.
 *
 * With a terminal attached, init turns the same findings into offers:
 * install the packs, run the first check, add a suppressions file, add a
 * CI step. Nothing is written to disk until the user accepts one. Without
 * a terminal, init prints the commands, which CI jobs that pipe
 * `suss init` rely on. `--write` prints them and then writes the setup
 * without asking, for an agent that has no terminal to answer in.
 */

import fs from "node:fs";
import path from "node:path";

import * as p from "@clack/prompts";

import {
  declaredPacks,
  formatInitReport,
  inspectProject,
  languageOf,
  readCommands,
  recognizedWithoutPackSentence,
  unnamedLanguageSentence,
  unnamedLanguages,
  withReadableCode,
  withReadableContracts,
} from "./init.js";
import { run } from "./processRun.js";
import { PROJECT_FILE, projectFileFor } from "./projectFile.js";
import { writeProjectSetup } from "./projectSetup.js";
import { hasProjectSource } from "./projectSource.js";
import { filesBelow, isProjectIn, projectsBelow } from "./projectsBelow.js";
import { DEFAULT_SUPPRESSIONS_FILENAMES } from "./suppressionsLoader.js";
import { readWorkspace } from "./workspaces.js";

import type { InitReport, PackSuggestion } from "./init.js";
import type { Language } from "./language.js";
import type { SetupLine } from "./projectSetup.js";
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
  /**
   * Print the commands, then write the setup without asking. An agent
   * setting a project up has no terminal to answer the guided form in.
   */
  write?: boolean;
  /** With `write`, replace a `suss.json` that is already there. */
  overwrite?: boolean;
}

export async function initInteractive(
  options: InteractiveInitOptions = {},
): Promise<number> {
  const root = path.resolve(options.dir ?? process.cwd());
  const targets = await findTargets(root);

  if (options.write === true) {
    process.stdout.write(printable(root, targets));
    process.stdout.write(
      writtenWithoutAsking(root, targets, options.overwrite === true),
    );
    return 0;
  }

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

  reportRecognizedWithoutPack(targets);
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
  const inWorkspace = workspace.packages.length > 0;
  const directories: Array<Omit<Target, "report">> = inWorkspace
    ? (workspace.packages as Workspace[]).map((pkg) => ({
        directory: pkg.directory,
        label: pkg.name ?? pkg.directory,
      }))
    : [{ directory: ".", label: path.basename(root) }];
  const add = (directory: string): void => {
    if (!directories.some((known) => known.directory === directory)) {
      directories.push({ directory, label: directory });
    }
  };

  // A workspace file never lists a Python or Ruby service next to the
  // packages, and a server and a client folder often sit side by side
  // with no workspace file at all, so look for every project below.
  for (const directory of pythonAndRubyProjectsAtOrBelow(root)) {
    add(directory);
  }

  for (const manifest of filesBelow(root, ["package.json"])) {
    add(path.dirname(manifest));
  }

  const targets: Target[] = [];
  for (const known of directories) {
    targets.push({
      ...known,
      report: withReadableCode(
        await withReadableContracts(
          await inspectProject(path.join(root, known.directory)),
        ),
      ),
    });
  }

  if (inWorkspace && !directories.some((known) => known.directory === ".")) {
    targets.push(await workspaceRootContracts(root));
  }

  const reported = withoutLanguagesCoveredBelow(
    withoutContractsOfProjectsBelow(targets),
  ).filter(isWorthReporting);
  return withRepositoryNotesOnce(reported);
}

/**
 * Whether a target has anything to report. Below the root, a folder often
 * has a manifest for tooling of its own, such as a Gemfile for a mobile
 * build or a package.json for docs. A folder there is reported when
 * something in it can be read, when a pack matched and an extract would
 * find nothing to read, or when its own manifest could not be read and it
 * has source of its own that the manifest may have hidden packs for.
 */
function isWorthReporting(target: Target): boolean {
  const { report } = target;
  if (target.directory === ".") {
    return worthReporting(report);
  }

  if (readsSomething(report) || (report.emptyExtracts ?? []).length > 0) {
    return true;
  }

  const ownUnread = (report.unread ?? []).some(
    (entry) => entry.aboutRepository !== true,
  );
  return (
    ownUnread &&
    (report.languages ?? []).some((language) =>
      hasProjectSource(report.root, language),
    )
  );
}

/**
 * The root finds the specs in the folders one level down, and each of
 * those folders is a target of its own now, so the root leaves them to
 * it. Read twice, one spec would look like two providers of every route.
 */
function withoutContractsOfProjectsBelow(targets: Target[]): Target[] {
  const below = targets
    .map((target) => target.directory)
    .filter((directory) => directory !== ".");
  return targets.map((target) =>
    target.directory === "."
      ? {
          ...target,
          report: {
            ...target.report,
            suggestions: target.report.suggestions.filter(
              (suggestion) =>
                suggestion.file === undefined ||
                !below.some((directory) =>
                  suggestion.file?.startsWith(`${directory}${path.sep}`),
                ),
            ),
          },
        }
      : target,
  );
}

/** A note about the whole repository goes on the first project that has it, rather than on every one. */
function withRepositoryNotesOnce(targets: Target[]): Target[] {
  const said = new Set<string>();
  return targets.map((target) => ({
    ...target,
    report: {
      ...target.report,
      unread: (target.report.unread ?? []).filter((entry) => {
        if (entry.aboutRepository !== true) {
          return true;
        }

        const key = `${entry.where}\n${entry.reason}`;
        if (said.has(key)) {
          return false;
        }

        said.add(key);
        return true;
      }),
    },
  }));
}

/**
 * A spec kept in a folder of its own at a workspace root belongs to no
 * package. The root's code is the packages', which have their own
 * targets, so from the root only the contracts are read.
 */
async function workspaceRootContracts(root: string): Promise<Target> {
  const report = await inspectProject(root);
  return {
    directory: ".",
    label: path.basename(root),
    report: await withReadableContracts({
      ...report,
      suggestions: report.suggestions.filter(
        (suggestion) => suggestion.kind === "contract",
      ),
      languages: [],
      unread: [],
      recognizedWithoutPack: [],
    }),
  };
}

/** The root and the directories below it that declare a Python or Ruby project of their own. */
function pythonAndRubyProjectsAtOrBelow(root: string): string[] {
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
 * the root would report them as languages suss could not place. When
 * nothing at the root declares a pack in such a language, its packs go
 * too: an extract at the root would read the projects below a second time.
 */
function withoutLanguagesCoveredBelow(targets: Target[]): Target[] {
  const coveredBelow = new Set(
    targets
      .filter((target) => target.directory !== ".")
      .flatMap((target) => declaredPacks(target.report))
      .map(languageOf),
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
            suggestions: target.report.suggestions.filter(
              (suggestion) =>
                suggestion.kind === "contract" ||
                !coveredBelow.has(languageOf(suggestion)) ||
                declaredAtRoot(target.report, languageOf(suggestion)),
            ),
          },
        }
      : target,
  );
}

/** Whether a manifest at the root, rather than a call in a file, led to a pack in this language. */
const declaredAtRoot = (report: InitReport, language: Language): boolean =>
  report.suggestions.some(
    (suggestion) =>
      languageOf(suggestion) === language &&
      suggestion.kind !== "contract" &&
      suggestion.shippedWithLanguage !== true,
  );

/**
 * Whether the root has anything to report. A Python root with no
 * requirements file gets no suggestions and has no unread manifest, but
 * the user still needs to hear about it.
 */
const worthReporting = (report: InitReport): boolean =>
  readsSomething(report) ||
  (report.unread ?? []).length > 0 ||
  (report.emptyExtracts ?? []).length > 0 ||
  unnamedLanguages(report).length > 0;

const readsSomething = (report: InitReport): boolean =>
  declaredPacks(report).length > 0 ||
  (report.recognizedWithoutPack ?? []).length > 0;

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
        target.directory === "." || entry.aboutRepository === true
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

/**
 * `init --write`: writes the setup for every project with packs, the
 * selection the guided form starts with, and returns what to print.
 */
function writtenWithoutAsking(
  root: string,
  targets: Target[],
  overwrite: boolean,
): string {
  const withPacks = targets.filter(
    (target) => declaredPacks(target.report).length > 0,
  );
  if (withPacks.length === 0) {
    return "\nNothing matched a pack, so init wrote nothing.\n";
  }

  if (!overwrite && fs.existsSync(path.join(root, PROJECT_FILE))) {
    return `\n${PROJECT_FILE} is already here, so init left it alone. Pass --overwrite as well to replace it with what init found.\n`;
  }

  const lines = writeProjectSetup(root, withPacks).map((line) => line.text);
  return `\n${lines.join("\n")}\n`;
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
        `${"═".repeat(4)} ${t.directory} ${"═".repeat(4)}\n\n${formatInitReport(t.report, t.directory)}`,
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

/** The same commands the printed form shows, minus an extract that would come back empty. */
function runCommandsFor(target: Target): RunnableCommand[] {
  return readCommands(target.report, target.directory)
    .filter((command) => !command.effectsOnly)
    .map((command) => ({
      bin: "npx",
      args: ["suss", ...command.args],
      display: `suss ${command.args.join(" ")}`,
      ...(command.needsConfig.length > 0
        ? { needsConfig: command.needsConfig }
        : {}),
    }));
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

  const found = chosen.some(
    (target) => projectFileFor(target.report, target.directory) !== null,
  );
  if (!found) {
    return;
  }

  const answer = await p.confirm({
    message: `Write ${PROJECT_FILE}, so later runs know what this project declares?`,
    initialValue: true,
  });
  if (p.isCancel(answer) || !answer) {
    return;
  }

  for (const line of writeProjectSetup(root, chosen)) {
    LOG_BY_TONE[line.tone](line.text);
  }
}

const LOG_BY_TONE: Record<SetupLine["tone"], (text: string) => void> = {
  done: (text) => p.log.success(text),
  note: (text) => p.log.warn(text),
};

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
