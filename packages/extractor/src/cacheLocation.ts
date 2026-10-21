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
 *
 * Several projects can share one chosen directory, so each project gets a
 * subdirectory whose name is a hash of its path.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  return createHash("sha256")
    .update(realPathOrSelf(path.resolve(projectDir)))
    .digest("hex")
    .slice(0, 16);
}

/** The extraction cache for the files read under `projectDir`. */
export function extractionCacheDirFor(projectDir: string): string {
  const root = chosenCacheRoot();
  if (root === null) {
    return path.join(projectDir, ".suss", "cache");
  }
  return path.join(root, "cache", projectKey(projectDir));
}

/** The file where the server for `projectDir` says how to reach it. */
export function liveRecordFor(projectDir: string): string {
  const root = chosenCacheRoot();
  if (root === null) {
    return path.join(projectDir, ".suss", "live", "server.json");
  }
  return path.join(root, "live", `${projectKey(projectDir)}.json`);
}
