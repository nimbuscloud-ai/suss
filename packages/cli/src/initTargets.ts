/**
 * The projects `suss init` finds under a root, each with what it found in
 * that project.
 *
 * In a workspace, each package is a project, and so is every folder
 * below the root with a manifest of its own. Init prints a report for
 * each and writes one `suss.json` that lists them all. Reading a
 * `suss.json` that suss 0.34.0 wrote needs the same list, because that
 * version left out the folder each entry came from, so this module has
 * no prompts in it and the reading code can call it too.
 */

import path from "node:path";

import {
  declaredPacks,
  inspectProject,
  languageOf,
  unnamedLanguages,
  withContractsReadOnce,
  withReadableCode,
} from "./init.js";
import { hasProjectSource, isSameOrUnder } from "./projectSource.js";
import { filesBelow, isProjectIn, projectsBelow } from "./projectsBelow.js";
import { withSharedLibraries } from "./sharedLibraries.js";
import { readWorkspace } from "./workspaces.js";

import type { InitReport } from "./init.js";
import type { Language } from "./language.js";
import type { Workspace } from "./workspaces.js";

export interface InitTarget {
  /** Relative to the directory init ran in, or "." for a single project. */
  directory: string;
  label: string;
  report: InitReport;
}

export async function findInitTargets(root: string): Promise<InitTarget[]> {
  const workspace = readWorkspace(root);
  const inWorkspace = workspace.packages.length > 0;
  const directories: Array<Omit<InitTarget, "report">> = inWorkspace
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

  const inspected: InitTarget[] = [];
  for (const known of directories) {
    inspected.push({
      ...known,
      report: await inspectProject(path.join(root, known.directory)),
    });
  }

  if (inWorkspace && !directories.some((known) => known.directory === ".")) {
    inspected.push(await workspaceRootContracts(root));
  }

  // A folder leaves the specs in the folders below it to them before any
  // spec is read. Copies are then compared across every folder, since one
  // check reads all of their summaries.
  const below = withoutContractsOfProjectsBelow(inspected);
  const reports = await withContractsReadOnce(
    root,
    below.map((target) => target.report),
  );
  const targets = below.map((target, index) => ({
    ...target,
    report: withReadableCode(reports[index] ?? target.report),
  }));

  const reported = withSharedLibraries(
    root,
    workspace,
    withoutLanguagesCoveredBelow(targets),
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
function isWorthReporting(target: InitTarget): boolean {
  const { report } = target;
  if (target.directory === ".") {
    return worthReporting(report);
  }

  if (
    readsSomething(report) ||
    (report.emptyExtracts ?? []).length > 0 ||
    report.sharedLibrary !== undefined
  ) {
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
 * A folder's walk finds the specs in the Python and Ruby projects below
 * it, and each of those is a target of its own, so the folder leaves
 * them to it. Read twice, one spec would look like two providers of
 * every route.
 */
function withoutContractsOfProjectsBelow(targets: InitTarget[]): InitTarget[] {
  const directories = targets.map((target) => target.directory);
  return targets.map((target) => {
    const below = directories.filter((directory) =>
      isBelow(directory, target.directory),
    );
    if (below.length === 0) {
      return target;
    }

    return {
      ...target,
      report: {
        ...target.report,
        suggestions: target.report.suggestions.filter(
          (suggestion) =>
            suggestion.file === undefined ||
            !below.some((directory) =>
              isSameOrUnder(
                path.join(target.directory, suggestion.file ?? ""),
                directory,
              ),
            ),
        ),
      },
    };
  });
}

function isBelow(directory: string, ancestor: string): boolean {
  return directory !== ancestor && isSameOrUnder(directory, ancestor);
}

/** A note about the whole repository goes on the first project that has it, rather than on every one. */
function withRepositoryNotesOnce(targets: InitTarget[]): InitTarget[] {
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
async function workspaceRootContracts(root: string): Promise<InitTarget> {
  const report = await inspectProject(root);
  return {
    directory: ".",
    label: path.basename(root),
    report: {
      ...report,
      suggestions: report.suggestions.filter(
        (suggestion) => suggestion.kind === "contract",
      ),
      languages: [],
      unread: [],
      recognizedWithoutPack: [],
    },
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
function withoutLanguagesCoveredBelow(targets: InitTarget[]): InitTarget[] {
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
