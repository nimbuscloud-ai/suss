/**
 * Finds the file that defines a constant.
 *
 * A Ruby codebase finds that file by a naming convention, with no load
 * graph a static reader could follow. So the adapter builds one path from
 * the constant's name and looks for it under the configured root and the
 * directories Rails autoloads from. No other spelling is tried.
 */

import fs from "node:fs";
import path from "node:path";

/** A pack picks a convention by name, and `PATH_CONVENTIONS` maps each name to its code. */
export type ConstantPathConvention = "railsUnderscore";

/**
 * A port of ActiveSupport's `String#underscore`, which Rails autoloading
 * runs a constant path through. The inflector treats an acronym the
 * project registers as one word, so with `ActivityPub` registered the
 * path is `activitypub` and never `activity_pub`.
 */
export function underscoreConstantPath(
  qualifiedName: string,
  acronyms: readonly string[] = [],
): string {
  return lowerAcronyms(qualifiedName.replaceAll("::", "/"), acronyms)
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function lowerAcronyms(word: string, acronyms: readonly string[]): string {
  if (acronyms.length === 0) {
    return word;
  }
  const alternatives = acronyms.map(escapeRegExp).join("|");
  const acronymRegex = new RegExp(
    `(?:(?<=([A-Za-z\\d]))|\\b)(${alternatives})(?=\\b|[^a-z])`,
    "g",
  );
  return word.replace(
    acronymRegex,
    (_match, before: string | undefined, acronym: string) =>
      `${before === undefined ? "" : "_"}${acronym.toLowerCase()}`,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATH_CONVENTIONS: Record<
  ConstantPathConvention,
  (qualifiedName: string, acronyms: readonly string[]) => string
> = {
  railsUnderscore: underscoreConstantPath,
};

/**
 * The file that defines a constant under `root`, or null when there is
 * none. Rails autoloads from every directory directly under `app`, and
 * from each `concerns` directory under those, so `ApplicationController`
 * is `app/controllers/application_controller.rb` and `Archivable` can be
 * `app/models/concerns/archivable.rb`. The root is tried first, then the
 * directories under it in name order, then their `concerns` directories
 * in the same order. Rails' own autoload glob lists them in that order.
 */
export function resolveConstantFile(
  root: string,
  qualifiedName: string,
  convention: ConstantPathConvention,
  acronyms: readonly string[] = [],
): string | null {
  const relative = `${PATH_CONVENTIONS[convention](qualifiedName, acronyms)}.rb`;
  for (const candidate of [root, ...autoloadDirectories(root)]) {
    const file = path.join(candidate, relative);
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return null;
}

function autoloadDirectories(root: string): string[] {
  const directories = subdirectories(root);
  const concerns = directories
    .map((directory) => path.join(directory, CONCERNS_DIRECTORY))
    .filter((directory) => isDirectory(directory));
  return [...directories, ...concerns];
}

const CONCERNS_DIRECTORY = "concerns";

function subdirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
