/**
 * The git checkout a directory is in, and the repository behind it.
 *
 * Every worktree of a repository shares one extraction cache, so a new
 * worktree reuses what any other checkout already read. The cache stores
 * paths under the checkout as relative to it and needs the checkout's
 * root for that, and the repository's main checkout says where the shared
 * cache lives. A directory outside git has neither, and its cache stays
 * where it always was.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Checkout {
  /** The checkout's top directory, with symlinks resolved. */
  root: string;
  /** The repository's own git directory, the same for every worktree of it. */
  commonDir: string;
  /** The checkout that owns `commonDir`, or null for a bare repository. */
  main: string | null;
}

const known = new Map<string, Checkout | null>();

/** The checkout `dir` is in, or null outside git or without git installed. */
export function checkoutOf(dir: string): Checkout | null {
  const resolved = path.resolve(dir);
  if (known.has(resolved)) {
    return known.get(resolved) ?? null;
  }
  const found = askGit(resolved);
  known.set(resolved, found);
  return found;
}

function askGit(dir: string): Checkout | null {
  try {
    const [top, common] = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    // Git prints both lines whenever it succeeds, and fails outside a work tree.
    /* v8 ignore start */
    if (top === undefined || common === undefined) {
      return null;
    }
    /* v8 ignore stop */
    const commonDir = fs.realpathSync(path.resolve(dir, common));
    return {
      root: fs.realpathSync(top),
      commonDir,
      main:
        path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The checkout's root as `file` spells it. A run reached through a
 * symlink, as macOS reaches `/tmp` through `/private/tmp`, writes its
 * paths that way, while git gives the resolved root. Null when `file` is
 * not under the checkout either way.
 */
export function rootAsSpelledBy(
  checkout: Checkout,
  file: string,
): string | null {
  const given = path.resolve(file);
  if (isUnder(given, checkout.root)) {
    return checkout.root;
  }
  let real: string;
  try {
    real = fs.realpathSync(given);
  } catch {
    return null;
  }
  if (!isUnder(real, checkout.root)) {
    return null;
  }
  const inside = real.slice(checkout.root.length);
  return given.endsWith(inside)
    ? given.slice(0, given.length - inside.length)
    : null;
}

function isUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}${path.sep}`);
}
