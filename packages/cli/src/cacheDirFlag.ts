/**
 * The `--cache-dir <path>` flag, for the commands that extract.
 *
 * Every adapter reads `SUSS_CACHE_DIR` to decide where its cache goes, so
 * the flag works by setting that variable for the length of the command.
 * It is taken out of the arguments before the command parses them, which
 * keeps it out of five separate option tables.
 */

import { CACHE_DIR_ENV } from "@suss/extractor";

import { UsageError } from "./usageError.js";

const FLAG = "--cache-dir";

/** The commands that can extract, and so can write a cache. */
export const COMMANDS_WITH_CACHE_DIR: ReadonlySet<string> = new Set([
  "init",
  "extract",
  "inspect",
  "check",
  "ask",
]);

/** The arguments without the flag, and the path it gave, if it was there. */
export function takeCacheDirFlag(args: readonly string[]): {
  args: string[];
  cacheDir: string | undefined;
} {
  const kept: string[] = [];
  let cacheDir: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (arg === "--") {
      kept.push(...args.slice(at));
      break;
    }

    if (arg.startsWith(`${FLAG}=`)) {
      cacheDir = arg.slice(FLAG.length + 1);
      continue;
    }

    if (arg !== FLAG) {
      kept.push(arg);
      continue;
    }

    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(
        `${FLAG} takes the directory suss may write its cache into. Try: ${FLAG} /tmp/suss-cache`,
      );
    }
    cacheDir = value;
    at++;
  }
  return { args: kept, cacheDir };
}

/** For a long-running process, such as the MCP server, to set it once. */
export function setCacheDir(cacheDir: string): void {
  process.env[CACHE_DIR_ENV] = cacheDir;
}

/**
 * Runs `run` with `SUSS_CACHE_DIR` set to the flag's path, then puts the
 * variable back. Without the flag, a value already in the environment is
 * used as it is.
 */
export async function withCacheDir<T>(
  cacheDir: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (cacheDir === undefined) {
    return await run();
  }

  const before = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = cacheDir;
  try {
    return await run();
  } finally {
    if (before === undefined) {
      delete process.env[CACHE_DIR_ENV];
    } else {
      process.env[CACHE_DIR_ENV] = before;
    }
  }
}
