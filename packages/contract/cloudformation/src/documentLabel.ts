// The label a manifest reader stamps on the summaries it reads out of
// one document, when the caller gives none.
//
// The label is the document's identity everywhere downstream: the
// reachability walk scopes its nodes by it, so two documents sharing a
// label share one scope, and one stack's question gets answered from
// another stack's rules. A basename is not enough for that, because a
// repository full of services gives every one of them a template.yaml.
// Where the file is within its repository does, so that is what the
// label says.

import fs from "node:fs";
import path from "node:path";

/** A spec named by URL keeps the URL: the fetched copy is a temp file whose name says nothing. */
const URL_ORIGIN = /^https?:\/\//i;

/**
 * The repository the file belongs to: the nearest ancestor holding a
 * `.git` entry. A linked worktree writes a file there rather than a
 * directory, so both count.
 *
 * Nearest, not outermost, which is worth knowing: a repository vendored
 * inside another repository is the repository for its own files, so two
 * of its documents at the same path within it collide again. A caller
 * that reads across such a tree passes `source` and says what each
 * document is called.
 */
function repositoryRoot(file: string): string | null {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

/** A path as a label reads it: forward slashes, whatever the platform writes. */
function withForwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Where the document is, relative to its repository. Outside a
 * repository the working directory takes that role, and a file above it
 * keeps its absolute path, which is unlovely but unique.
 */
function documentPathLabel(origin: string): string {
  const resolved = path.resolve(origin);
  const base = repositoryRoot(resolved) ?? process.cwd();
  const relative = path.relative(base, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return withForwardSlashes(resolved);
  }

  return withForwardSlashes(relative);
}

/**
 * The provenance label for a document read from `origin`, which is
 * either a path on disk or the URL it was fetched from. `prefix` gives
 * the reader, the way `cloudformation:template.yaml` always did.
 */
export function documentSourceLabel(prefix: string, origin: string): string {
  if (URL_ORIGIN.test(origin)) {
    return `${prefix}:${origin}`;
  }

  return `${prefix}:${documentPathLabel(origin)}`;
}
