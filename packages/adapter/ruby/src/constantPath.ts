/**
 * Finds the file behind a constant.
 *
 * A Ruby codebase locates that file by a naming convention rather than through a
 * load graph a static reader could follow, so we build one path from the
 * constant's own name and look for it under the configured root and the
 * directories Rails autoloads from. No other spelling is tried.
 */

import fs from "node:fs";
import path from "node:path";

/** A pack picks a convention by name, and the code for each one lives here. */
export type ConstantPathConvention = "railsUnderscore";

/** Ported from ActiveSupport's own `String#underscore`, which is what Rails autoloading runs a constant path through. */
export function underscoreConstantPath(qualifiedName: string): string {
  return qualifiedName
    .replaceAll("::", "/")
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

const PATH_CONVENTIONS: Record<
  ConstantPathConvention,
  (qualifiedName: string) => string
> = {
  railsUnderscore: underscoreConstantPath,
};

/**
 * Null when there is no file at that path. Rails autoloads from every
 * directory directly under `app`, so `ApplicationController` is
 * `app/controllers/application_controller.rb` and not
 * `app/application_controller.rb`; those directories are tried after
 * the root itself, in name order, and no other spelling is tried.
 */
export function resolveConstantFile(
  root: string,
  qualifiedName: string,
  convention: ConstantPathConvention,
): string | null {
  const relative = `${PATH_CONVENTIONS[convention](qualifiedName)}.rb`;
  for (const candidate of [root, ...autoloadDirectories(root)]) {
    const file = path.join(candidate, relative);
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return null;
}

function autoloadDirectories(root: string): string[] {
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
