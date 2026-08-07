// constantPath.ts: Rails' constant-to-path naming convention.
//
// Rails autoloading (Zeitwerk) does not name a file; it names a
// directory structure a constant path is expected to sit under, and
// loads whichever file matches when the constant is first referenced.
// There is no load graph to read statically, so this is not module
// resolution the way moduleResolver.ts is on the Python side: it is one
// deterministic path built from a constant's own name, checked once
// against the configured graphql root. A path that does not exist on
// disk is unresolved; nothing here searches multiple roots or picks
// among candidates.

import fs from "node:fs";
import path from "node:path";

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

/**
 * The file a constant path names under Rails' convention, rooted at
 * `root` (a pack's configured graphql directory), or null when no file
 * sits there. The one check this makes; it does not fall back to
 * another root or another spelling.
 */
export function resolveConstantFile(
  root: string,
  qualifiedName: string,
): string | null {
  const file = path.join(root, `${underscoreConstantPath(qualifiedName)}.rb`);
  return fs.existsSync(file) ? file : null;
}
