/**
 * A directory suss writes for itself, such as the extraction cache, can
 * land in any package of a repository, where a root `.gitignore` entry
 * for `/.suss` does not reach. A `.gitignore` of `*` inside it keeps it
 * out of version control wherever it is, the way pytest's cache does.
 */

import fs from "node:fs";
import path from "node:path";

/** Creates `dir` and a `.gitignore` of `*` in it. A `.gitignore` already there is kept. */
export function makeIgnoredDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "*\n");
  }
}
