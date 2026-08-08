/**
 * Finds the file behind a constant.
 *
 * A Ruby codebase locates that file by a naming convention rather than through a
 * load graph a static reader could follow, so we build one path from the
 * constant's own name and check it once against the configured root. Nothing
 * here searches several roots or chooses between candidates.
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

/** Null when there is no file at that path. We do not fall back to another root or another spelling. */
export function resolveConstantFile(
  root: string,
  qualifiedName: string,
  convention: ConstantPathConvention,
): string | null {
  const relative = PATH_CONVENTIONS[convention](qualifiedName);
  const file = path.join(root, `${relative}.rb`);
  return fs.existsSync(file) ? file : null;
}
