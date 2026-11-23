/**
 * What `suss init` prints for a repository: the report for one project,
 * or, for several, one line per project and one set of steps, and the
 * same findings as JSON with `--json`.
 *
 * Several projects read into one `summaries/` folder that one check
 * compares, so the steps are printed once with every project's commands
 * in them. The text keeps to what a user acts on, and `--json` has the
 * reason each pack was picked as well.
 */

import fs from "node:fs";
import path from "node:path";

import {
  declaredPacks,
  formatInitReport,
  notReadLines,
  readCommands,
  settledValues,
  setupStepLines,
  unnamedLanguages,
} from "./init.js";
import { bold, cyan, dim, green, yellow } from "./style.js";

import type { InitReport, PackSuggestion } from "./init.js";
import type { InitTarget } from "./initTargets.js";
import type { UnreadSource } from "./unreadSource.js";

/** Directories longer than this get their own width rather than padding every line. */
const DIRECTORY_COLUMN = 24;

export function formatInitTargets(
  root: string,
  targets: readonly InitTarget[],
  unread: readonly UnreadSource[],
): string {
  return `${[...targetLines(root, targets), ...unreadSourceLines(unread)].join("\n")}\n`;
}

function targetLines(root: string, targets: readonly InitTarget[]): string[] {
  const [only] = targets;
  if (only === undefined) {
    return reportLines(
      formatInitReport({ root, tsconfig: null, suggestions: [] }),
    );
  }
  if (targets.length === 1 && only.directory === ".") {
    return reportLines(formatInitReport(only.report));
  }

  const width = Math.min(
    DIRECTORY_COLUMN,
    Math.max(...targets.map((target) => target.directory.length)),
  );
  const lines = [
    `${green("✓")} Found ${bold(`${targets.length} projects`)} to read in ${root}`,
    "",
    ...targets.map(
      (target) =>
        `  ${cyan(target.directory.padEnd(width))}  ${dim(summaryOf(target.report))}`,
    ),
    "",
  ];
  if (targets.some((target) => readCommands(target.report).length > 0)) {
    lines.push(...setupStepLines(targets));
  }

  for (const target of targets) {
    const notes = notReadLines(target.report);
    if (notes.length > 0) {
      lines.push("", bold(target.directory), ...withoutLeadingBlank(notes));
    }
  }
  return lines;
}

function reportLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

function withoutLeadingBlank(lines: readonly string[]): string[] {
  return lines[0] === "" ? lines.slice(1) : [...lines];
}

/** One line on what init found in a project, which the notes under the steps explain when it is nothing. */
function summaryOf(report: InitReport): string {
  if (declaredPacks(report).length > 0) {
    return [...new Set(report.suggestions.map((one) => one.name))].join(", ");
  }
  if (report.sharedLibrary !== undefined) {
    return "shared code, with no extract of its own";
  }
  if ((report.emptyExtracts ?? []).length > 0) {
    return "an extract here would find no file to read";
  }
  return "nothing here matched a pack";
}

/** The source no command reads, one folder at a time with its reasons under it. */
export function unreadSourceLines(unread: readonly UnreadSource[]): string[] {
  if (unread.length === 0) {
    return [];
  }

  return [
    "",
    `  ${yellow("!")} ${bold("Source suss does not read")}`,
    ...unread.flatMap((entry) => [
      `    ${cyan(entry.directory)}`,
      ...entry.reasons.map((reason) => `      ${dim(reason)}`),
    ]),
  ];
}

/** Everything init found, for a script or an agent to read. */
export function initJson(
  root: string,
  targets: readonly InitTarget[],
  unread: readonly UnreadSource[],
): Record<string, unknown> {
  return {
    root,
    projects: targets.map((target) => {
      const { report } = target;
      return {
        directory: target.directory,
        label: target.label,
        tsconfig: report.tsconfig,
        languages: report.languages ?? [],
        packs: report.suggestions.map((suggestion) =>
          packJson(report.root, suggestion),
        ),
        commands: readCommands(report, target.directory).map((command) => ({
          command: `suss ${command.args.join(" ")}`,
          ...(command.language === undefined
            ? {}
            : { language: command.language }),
          readsAlone: !command.effectsOnly,
          writeFirst: command.needsConfig,
        })),
        unreadManifests: report.unread ?? [],
        recognizedWithoutPack: report.recognizedWithoutPack ?? [],
        emptyContracts: report.emptyContracts ?? [],
        coveredContracts: report.coveredContracts ?? [],
        emptyExtracts: report.emptyExtracts ?? [],
        unnamedLanguages: unnamedLanguages(report),
        ...(report.sharedLibrary === undefined
          ? {}
          : { sharedLibrary: report.sharedLibrary }),
      };
    }),
    unreadSource: unread,
  };
}

function packJson(
  projectRoot: string,
  suggestion: PackSuggestion,
): Record<string, unknown> {
  const { configuration } = suggestion;
  const settled =
    configuration === undefined
      ? null
      : settledValues(configuration, projectRoot, suggestion.language);
  return {
    name: suggestion.name,
    package: suggestion.packageName,
    kind: suggestion.kind,
    because: suggestion.because,
    ...(suggestion.language === undefined
      ? {}
      : { language: suggestion.language }),
    ...(suggestion.file === undefined ? {} : { file: suggestion.file }),
    ...(suggestion.calledThrough === undefined
      ? {}
      : { calledThrough: suggestion.calledThrough }),
    ...(configuration === undefined
      ? {}
      : {
          config: {
            file: configuration.file,
            required: configuration.required,
            onDisk: fs.existsSync(path.join(projectRoot, configuration.file)),
            values: settled?.values ?? null,
            ...(settled?.from === undefined ? {} : { from: settled.from }),
            ...(settled?.choice === undefined
              ? {}
              : { choice: settled.choice }),
          },
        }),
  };
}
