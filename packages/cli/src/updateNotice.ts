/**
 * One stderr line when a newer suss is on the registry, at the end of
 * an interactive run.
 *
 * The check is one fetch of the registry's `latest` tag, remembered in
 * a file for a day so repeated runs cost nothing, and skipped whenever
 * nobody is there to read it: stderr not a terminal, CI set, or the
 * environment opting out with SUSS_NO_UPDATE_NOTICE. A network failure
 * says nothing, since the run it decorates already did its work.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REGISTRY_URL = "https://registry.npmjs.org/@suss%2fcli/latest";

interface CachedCheck {
  checkedAt: number;
  latest: string;
}

function cacheFile(): string {
  return path.join(os.tmpdir(), "suss-update-check.json");
}

function readCache(): CachedCheck | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(cacheFile(), "utf8"),
    ) as CachedCheck;
    return typeof parsed.latest === "string" &&
      typeof parsed.checkedAt === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ checkedAt: Date.now(), latest }),
    );
  } catch {
    // A read-only tmpdir costs a fetch per run, nothing else.
  }
}

export function installedVersion(): string | null {
  try {
    const packageJson = fileURLToPath(
      new URL("../package.json", import.meta.url),
    );
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function latestVersion(): Promise<string | null> {
  const cached = readCache();
  if (cached !== null && Date.now() - cached.checkedAt < CACHE_MAX_AGE_MS) {
    return cached.latest;
  }
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      return null;
    }
    writeCache(body.version);
    return body.version;
  } catch {
    return null;
  }
}

/** Whether `latest` is ahead of `installed`, by numeric semver parts. */
export function isBehind(installed: string, latest: string): boolean {
  const parse = (v: string): number[] =>
    v.split("-")[0]?.split(".").map(Number) ?? [];
  const a = parse(installed);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    const own = a[i] ?? 0;
    const theirs = b[i] ?? 0;
    if (own !== theirs) {
      return own < theirs;
    }
  }
  return false;
}

export async function printUpdateNoticeIfBehind(): Promise<void> {
  if (
    !process.stderr.isTTY ||
    process.env.CI !== undefined ||
    process.env.SUSS_NO_UPDATE_NOTICE !== undefined
  ) {
    return;
  }
  const installed = installedVersion();
  if (installed === null) {
    return;
  }
  const latest = await latestVersion();
  if (latest === null || !isBehind(installed, latest)) {
    return;
  }
  process.stderr.write(
    `suss update available ${installed} → ${latest} · npm i -D @suss/cli\n`,
  );
}
