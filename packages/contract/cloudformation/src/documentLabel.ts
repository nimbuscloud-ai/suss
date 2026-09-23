/**
 * The label a manifest reader puts on the summaries from one document
 * when the caller does not pass one.
 *
 * Everything downstream uses the label to tell documents apart. The
 * reachability walk scopes its nodes by it, so two documents with the
 * same label share one scope, and a question about one stack gets
 * answered with another stack's rules. A basename is too weak for this,
 * because in a repository of services every one has a template.yaml, so
 * the label is the file's path within its repository.
 */

import fs from "node:fs";
import path from "node:path";

// A spec fetched from a URL keeps the URL, because the fetched copy is a
// temp file with a meaningless name.
const URL_ORIGIN = /^https?:\/\//i;

/**
 * The nearest ancestor with a `.git` entry, which a linked worktree
 * writes as a file. A repository vendored inside another is its own root,
 * so a caller reading such a tree should pass `source` for each document.
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

// Labels use forward slashes on every platform so they match across runs.
function withForwardSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * The document's path relative to its repository, or to the working
 * directory outside one. A file above that directory keeps its absolute
 * path, which is long but still unique.
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
 * The provenance label for a document read from `origin`, which is a
 * path on disk or the URL it was fetched from. `prefix` is the reader's
 * name, as in `cloudformation:infra/template.yaml`.
 */
export function documentSourceLabel(prefix: string, origin: string): string {
  if (URL_ORIGIN.test(origin)) {
    return `${prefix}:${origin}`;
  }

  return `${prefix}:${documentPathLabel(origin)}`;
}
