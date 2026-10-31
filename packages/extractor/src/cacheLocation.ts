/**
 * Where suss keeps the files it writes for itself while it reads a
 * project: the extraction cache, and the record the MCP server leaves for
 * the plugin's hooks.
 *
 * By default they go under `.suss` in the project, which fails in a
 * checkout the process may only read. `SUSS_CACHE_DIR` moves them
 * somewhere else. The `--cache-dir` flag and the MCP server's argument
 * set the same variable for the process, so one setting reaches every
 * adapter and a flag wins over the variable already in the environment.
 * Several projects can share one chosen directory, so each project gets a
 * subdirectory of its own. The extraction cache is the one every worktree
 * of a repository shares.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { checkoutOf } from "./checkout.js";

export const CACHE_DIR_ENV = "SUSS_CACHE_DIR";

/** The directory the environment names, made absolute, or null when it names none. */
export function chosenCacheRoot(): string | null {
  const chosen = process.env[CACHE_DIR_ENV];
  if (chosen === undefined || chosen === "") {
    return null;
  }
  return path.resolve(chosen);
}

/**
 * Hashes the real path, so a project reached through a symlink (macOS
 * keeps /tmp under /private) has one key however it is named. The plugin's
 * hook script computes the same key and has a test that they agree.
 */
function realPathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function projectKey(projectDir: string): string {
  return hashKey(realPathOrSelf(path.resolve(projectDir)));
}

function hashKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The extraction cache for the files read under `projectDir`. Every
 * worktree of a repository shares one: under the main checkout, at the
 * project's place in it, or under the chosen root by the repository and
 * that place. A directory outside git keeps a cache of its own.
 */
export function extractionCacheDirFor(projectDir: string): string {
  const shared = placeInRepository(projectDir);
  const root = chosenCacheRoot();
  if (root !== null) {
    return path.join(
      root,
      "cache",
      shared === null
        ? projectKey(projectDir)
        : hashKey(`${shared.commonDir}\u0000${shared.relative}`),
    );
  }
  if (shared === null || shared.main === null) {
    return path.join(projectDir, ".suss", "cache");
  }
  return path.join(shared.main, shared.relative, ".suss", "cache");
}

/** Where `projectDir` is in its repository, the same for every worktree, or null outside git. */
function placeInRepository(
  projectDir: string,
): { commonDir: string; main: string | null; relative: string } | null {
  const checkout = checkoutOf(projectDir);
  if (checkout === null) {
    return null;
  }
  const relative = path.relative(checkout.root, realPathOrSelf(projectDir));
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? null
    : { commonDir: checkout.commonDir, main: checkout.main, relative };
}

/**
 * The folder `suss map` writes its page and the summaries behind it to:
 * `.suss` in the project, or a folder of its own under the chosen root.
 */
export function mapFolderFor(projectDir: string): string {
  const root = chosenCacheRoot();
  if (root === null) {
    return path.join(projectDir, ".suss");
  }
  return path.join(root, "map", projectKey(projectDir));
}

/** The file where the server for `projectDir` says how to reach it. */
export function liveRecordFor(projectDir: string): string {
  const root = chosenCacheRoot();
  if (root === null) {
    return path.join(projectDir, ".suss", "live", "server.json");
  }
  return path.join(root, "live", `${projectKey(projectDir)}.json`);
}
