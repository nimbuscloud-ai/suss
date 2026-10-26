/**
 * Workspace packages with no entry point of their own, such as the
 * database and AWS helpers every service in a monorepo imports.
 *
 * No pack finds a route, a handler or a component in a package like that.
 * Its packs only read calls that other code makes, so an extract of it
 * alone comes back empty. Each service's read already follows its calls
 * into the sibling packages it imports, and init gives that read the
 * packs its sibling packages need, so the tables a helper touches are
 * credited to the routes that call it. Such a package therefore gets no
 * read of its own. Its report says which packages read it, or that
 * nothing does. A contract it declares, such as a Prisma schema, is still
 * read.
 */

import fs from "node:fs";
import path from "node:path";

import { countsForProject, languageOf, readCommands } from "./init.js";
import { dependenciesThroughLocalPackages } from "./workspaces.js";

import type { InitReport, PackSuggestion } from "./init.js";
import type { InitTarget } from "./initTargets.js";
import type { WorkspaceLayout } from "./workspaces.js";

export function withSharedLibraries(
  root: string,
  workspace: WorkspaceLayout,
  targets: readonly InitTarget[],
): InitTarget[] {
  const inWorkspace = new Set(workspace.packages.map((pkg) => pkg.directory));
  const libraries = new Set(
    targets
      .filter(
        (target) =>
          inWorkspace.has(target.directory) && hasNoEntryPoint(target.report),
      )
      .map((target) => target.directory),
  );
  if (libraries.size === 0) {
    return [...targets];
  }

  const readers = targets.filter(
    (target) =>
      !libraries.has(target.directory) && readsTypeScript(target.report),
  );
  const reached = new Map(
    readers.map((reader) => [
      reader.directory,
      localDependencies(root, reader.directory),
    ]),
  );

  return targets.map((target) => {
    if (!libraries.has(target.directory)) {
      return target;
    }

    const readBy = readers
      .filter((reader) => reached.get(reader.directory)?.has(target.directory))
      .map((reader) => reader.directory);
    return { ...target, report: asLibrary(target.report, readBy) };
  });
}

/** Whether every TypeScript pack that counts here only reads calls inside units another pack finds. */
function hasNoEntryPoint(report: InitReport): boolean {
  return readCommands(report).some(
    (command) => command.language === "typescript" && command.effectsOnly,
  );
}

function readsTypeScript(report: InitReport): boolean {
  return report.suggestions.some(
    (suggestion) =>
      isTypeScriptCode(suggestion) && countsForProject(suggestion),
  );
}

function isTypeScriptCode(suggestion: PackSuggestion): boolean {
  return (
    suggestion.kind !== "contract" && languageOf(suggestion) === "typescript"
  );
}

/** The report with its TypeScript packs taken out, so no extract reads it. */
function asLibrary(report: InitReport, readBy: string[]): InitReport {
  return {
    ...report,
    suggestions: report.suggestions.filter(
      (suggestion) => !isTypeScriptCode(suggestion),
    ),
    sharedLibrary: {
      packs: report.suggestions.filter(isTypeScriptCode).map((one) => one.name),
      readBy,
    },
  };
}

/** The packages of this repository the one at `directory` depends on, at any depth, relative to the root. */
function localDependencies(root: string, directory: string): Set<string> {
  // A folder found through a node_modules link comes back with its symlinks resolved.
  const top = fs.realpathSync(root);
  return new Set(
    dependenciesThroughLocalPackages(path.join(top, directory)).flatMap(
      (dependency) =>
        dependency.local === null ? [] : [path.relative(top, dependency.local)],
    ),
  );
}
