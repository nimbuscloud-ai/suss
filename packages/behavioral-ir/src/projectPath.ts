/**
 * How a summary spells a file on disk: relative to the root of the
 * project it was read from, with forward slashes.
 *
 * A summary's id and location are built from this spelling, so two
 * checkouts of one project at different absolute paths write the same
 * summaries, and a diff between them shows only what the code changed.
 * The CLI works out the root once per read and passes it to the reader.
 * A reader called without one measures from the repository the file is
 * in, or from the working directory outside one. A file outside the
 * root gets a path that climbs out of it, never an absolute one.
 */

import fs from "node:fs";
import path from "node:path";

// A spec fetched from a URL keeps the URL, because the fetched copy is a
// temp file with a meaningless name.
const URL_ORIGIN = /^https?:\/\//i;

/** `file` relative to `root`, with forward slashes on every platform. */
export function pathInProject(file: string, root: string): string {
  const relative = path.relative(root, path.resolve(file));
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

/** The root a reader measures `file` from when its caller gives none. */
export function defaultProjectRoot(file: string): string {
  return repositoryRoot(path.resolve(file)) ?? process.cwd();
}

/**
 * The label a reader puts on the summaries from one document, as in
 * `cloudformation:infra/template.yaml`. Everything downstream tells
 * documents apart by it, and in a repository of services every one has
 * a template.yaml, so the label is the document's path in its project.
 */
export function documentSourceLabel(
  prefix: string,
  origin: string,
  root?: string,
): string {
  if (URL_ORIGIN.test(origin)) {
    return `${prefix}:${origin}`;
  }

  return `${prefix}:${pathInProject(origin, root ?? defaultProjectRoot(origin))}`;
}

/**
 * The nearest ancestor with a `.git` entry, which a linked worktree
 * writes as a file. A repository vendored inside another is its own root.
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
