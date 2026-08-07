// constantPath.ts: named constant-to-path conventions.
//
// A Ruby codebase locates the file behind a constant by a naming
// convention, not by a load graph a static reader could follow. Each
// convention this adapter implements has a name, and a pack selects
// one by that name; the algorithm stays here. One convention exists
// today: `railsUnderscore`, Rails autoloading's (Zeitwerk's) rule. It
// does not name a file directly; it names a directory structure a
// constant path is expected to sit under, and loads whichever file
// matches when the constant is first referenced. So this is not module
// resolution the way moduleResolver.ts is on the Python side: it is one
// deterministic path built from a constant's own name, checked once
// against the configured root. A path that does not exist on disk is
// unresolved; nothing here searches multiple roots or picks among
// candidates.

import fs from "node:fs";
import path from "node:path";

/** A constant-to-path convention this adapter knows how to run. A pack selects one by name; the algorithm lives here. */
export type ConstantPathConvention = "railsUnderscore";

/**
 * The Rails/ActiveSupport `underscore` conversion: `Mutations::CampaignUpdate`
 * becomes `mutations/campaign_update`. Ported directly from
 * ActiveSupport's own implementation (`String#underscore`), since the
 * file-naming convention it defines is exactly what a constant path
 * maps to on disk.
 */
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
 * The file a constant path names under the selected convention, rooted
 * at `root` (a pack's configured directory), or null when no file sits
 * there. The one check this makes; it does not fall back to another
 * root or another spelling.
 */
export function resolveConstantFile(
  root: string,
  qualifiedName: string,
  convention: ConstantPathConvention,
): string | null {
  const relative = PATH_CONVENTIONS[convention](qualifiedName);
  const file = path.join(root, `${relative}.rb`);
  return fs.existsSync(file) ? file : null;
}
